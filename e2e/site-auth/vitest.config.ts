// SPDX-License-Identifier: GPL-3.0-or-later
//
// Dedicated config for the site-authenticated bridge suite. Kept separate from
// the unit vitest config (which scans `src/**`) so these tests NEVER run in
// `pnpm test` / CI - they require a human-logged-in Chrome with the Playwright
// Extension. Node environment (the harness talks to a real browser via MCP; no
// local jsdom), single sequential process (one bridge connection at a time).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { loadE2eEnvFiles } from "../lib/load-env";

const here = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(here, "..", "..");

// Load the same .env files the Playwright config uses (shared loader, so the
// file list stays in lockstep), so the bridge suite can reach the test-account
// creds (E2E_AUTH_EMAIL/OTP) and URL overrides. Shell env wins. Passed
// through `test.env` so it reaches the forked test workers.
function loadEnv(): Record<string, string> {
  const out = loadE2eEnvFiles(extensionRoot);
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

export default defineConfig({
  root: here,
  test: {
    env: loadEnv(),
    environment: "node",
    include: ["**/*.test.ts"],
    globals: false,
    fileParallelism: false,
    pool: "forks",
    maxWorkers: 1,
    isolate: false,
    // Default for a test that drives a live, logged-in page. The heavy-feed deep
    // scroll needs several times this and carries its own budget (lifecycle.test.ts).
    testTimeout: 180_000,
    // Floor for the hooks that DON'T pass their own budget (teardown, restores).
    // The expensive one - the fail-fast setup, which navigates + polls for the
    // host on a cold first-file connection - carries SETUP_HOOK_TIMEOUT_MS.
    hookTimeout: 120_000,
    // Black-box runs against live, bot-sensitive platforms flake (esp. Facebook:
    // lazy hydration, interstitials, photo-permalink overlaps). Retry transient
    // flakes - a genuine "not logged in" still fails every attempt with its
    // actionable message. Configurable; 0 to reproduce raw.
    retry: Number(process.env.E2E_RETRIES ?? 2),
    // Real reactions + real navigation are slow and order-sensitive.
    sequence: { concurrent: false },
  },
});
