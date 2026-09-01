#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Fail the build if the AMO source archive ships a file it must never carry. The zip is
# built by wxt, which does NOT honour .gitignore - untracked is not the same as excluded,
# so the archive gets its own gate instead of trusting `zip.excludeSources` to stay right.
# Shared by the CI and release workflows so both gate on exactly the same rules.
#
#   bash scripts/scan-source-archive.sh [archive.zip]   (default: the one in .output/)

set -euo pipefail

source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/secret-patterns.sh"

archive="${1:-}"
if [ -z "$archive" ]; then
  archive="$(find .output -maxdepth 1 -name 'emojery-v*-sources.zip' -print -quit)"
fi
test -n "$archive"
test -f "$archive"

listing="$(unzip -Z1 "$archive")"
# An empty listing would pass every check below vacuously - same guard as the
# sibling gates (scan-extension-artifact.sh, check-bundle-budget.mjs).
if [ -z "$listing" ]; then
  echo "::error::source archive listing is empty - nothing was scanned"
  exit 1
fi

# Paths that must not be in the archive at all. The `.env*.example` carve-out is defensive:
# wxt.config.ts already drops every `.env.*` from the archive, so it can only ever matter if
# that exclusion is narrowed. `-i`: a zip listing preserves case, so `KEY.PEM` must fail the
# gate the same as `key.pem`. The carve-out stays case-sensitive on purpose - it should only
# spare the lowercase `.example` files the build actually ships, never an oddly-cased sibling.
forbidden_paths="$(printf '%s\n' "$listing" | grep -iE '(^|/)\.env($|\.)|(^|/)\.playwright/|(^|/)node_modules/|(^|/)\.output/|\.(pem|key|p12|pfx)$|\.zip$' | grep -vE '(^|/)\.env(\.[a-z0-9.]+)?\.example$' || true)"
if [ -n "$forbidden_paths" ]; then
  echo "::error::source archive contains files that must never be published"
  printf '%s\n' "$forbidden_paths"
  exit 1
fi

# Contents: real credential shapes plus the e2e test-auth values.
#
# `-a`, never `-I`: the archive streams as ONE mixed text+binary input, and `-I`
# makes grep call the whole stream binary the moment it hits the first sprite
# byte - it then exits 1 even for a match it already printed, so the gate passed
# on a real hit (reproduced). `-a` scans the stream as text and reports honestly.
#
# The 3 excluded entries are this gate's own sources: they carry the credential
# SHAPES as literal pattern text, so scanning them only ever finds the patterns
# themselves. Everything else in the archive is scanned.
deny="${SECRET_PATTERN_PREFIX}|${E2E_CREDENTIAL_PATTERN}"
if unzip -p "$archive" -x 'scripts/lib/secret-patterns.sh' 'scripts/scan-source-archive.sh' 'scripts/scan-extension-artifact.sh' | grep -anE "$deny"; then
  echo "::error::source archive contains a forbidden secret pattern"
  exit 1
fi
