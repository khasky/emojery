#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Fail the build if a generated extension directory ships a source map or any secret/debug
# pattern that must never reach a store upload. Run against BOTH shipped targets
# (.output/chrome-mv3 and .output/firefox-mv2) by the CI and release workflows, so both
# gate on exactly the same rules.
#
# Only ever point this at a PRODUCTION build: the staging backend is a forbidden pattern
# here, and a staging build legitimately contains it.
#
#   bash scripts/scan-extension-artifact.sh [artifact-dir]   (default .output/chrome-mv3)

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$script_dir/lib/secret-patterns.sh"

artifact="${1:-.output/chrome-mv3}"
test -d "$artifact"

# Read, not repeated: STAGING_API_BASE lives in src/shared/api-origins.ts. A second literal
# here would keep passing after that origin changed - a staging-pointed build sailing into a
# store upload is the one failure this gate exists to make loud, and the only silent one.
staging_host="$(sed -n 's|^export const STAGING_API_BASE = "https://\([^"/]*\)".*|\1|p' "$script_dir/../src/shared/api-origins.ts")"
if [ -z "$staging_host" ]; then
  echo "::error::could not read STAGING_API_BASE from src/shared/api-origins.ts - the staging-origin check would pass vacuously"
  exit 1
fi
staging_pattern="${staging_host//./\\.}"

if find "$artifact" -name '*.map' -print -quit | grep -q .; then
  echo "::error::source maps must not be included in the extension artifact"
  find "$artifact" -name '*.map' -print
  exit 1
fi

# By PATH as well as by content: the content grep matches credential SHAPES, so a key
# file whose (often binary) bytes match no shape - a DER keystore, a .p12 - would pass it
# on content alone. The name gate catches those. Same shapes the source-archive gate
# rejects, so both gates refuse the same files.
key_paths="$(find "$artifact" \( -name '*.pem' -o -name '*.key' -o -name '*.p12' -o -name '*.pfx' -o -name '.env' -o -name '.env.*' \) -print)"
if [ -n "$key_paths" ]; then
  echo "::error::extension artifact contains a key/credential file"
  printf '%s\n' "$key_paths"
  exit 1
fi

# The staging host: wxt.config.ts lets a production-mode build be pointed at the staging
# backend (the e2e build uses that). A store upload must never carry it.
#
# The bearer/JWT shapes are artifact-only, not in the shared prefix: the source archive
# legitimately carries a documented sample JWT (src/background/debug.test.ts), and the
# shipped bundle's own `Bearer ${...}` template stays unmatched because `$` ends the token
# character class.
deny="${SECRET_PATTERN_PREFIX}|${E2E_CREDENTIAL_PATTERN}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}|Bearer [A-Za-z0-9._-]{20,}|\.env|localhost|127\.0\.0\.1|sourceMappingURL|${staging_pattern}"
# --binary-files=text, not the default binary-skip: a secret embedded in a .wasm, a font,
# or a minified bundle carrying a NUL byte would otherwise never be scanned. Same choice
# scan-source-archive.sh made for the same reason.
if grep -RInE --binary-files=text "$deny" "$artifact"; then
  echo "::error::extension artifact contains a forbidden secret/debug pattern"
  exit 1
fi
