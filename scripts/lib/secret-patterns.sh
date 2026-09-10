# SPDX-License-Identifier: GPL-3.0-or-later
#
# Credential-shape patterns shared by the two artifact-scan gates
# (scan-extension-artifact.sh, scan-source-archive.sh) so a new secret shape added
# here protects both. Each gate appends its own artifact-specific tail to $deny.
SECRET_PATTERN_PREFIX='sk_live_|rk_live_|ghp_|github_pat_|sk-ant-[A-Za-z0-9_-]{10,}|npm_[A-Za-z0-9]{36}|glpat-[A-Za-z0-9_-]{20}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|-----BEGIN (RSA |EC |OPENSSH |)?PRIVATE KEY-----'

# A harness token no generic ruleset recognises: only the variable name
# identifies it, so the key is matched against a shape-free value class - it
# catches strictly more, and says nothing about what the value looks like. The
# excluded leading characters keep an empty `KEY=`, a documented placeholder and
# this file's own definition below from reading as a hit.
E2E_CREDENTIAL_VALUE='[^[:space:]<"$[]'
E2E_CREDENTIAL_PATTERN="PLAYWRIGHT_MCP_EXTENSION_TOKEN=${E2E_CREDENTIAL_VALUE}"
