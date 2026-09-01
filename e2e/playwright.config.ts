// SPDX-License-Identifier: GPL-3.0-or-later

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { loadE2eEnvFiles } from "./lib/load-env";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..");

loadEnvFiles();

const testTimeout = Number(process.env.E2E_TEST_TIMEOUT_MS ?? 120_000);
const expectTimeout = Number(process.env.E2E_EXPECT_TIMEOUT_MS ?? 30_000);
// Black-box tests against LIVE third-party sites and the live auth backend flake
// on causes outside the extension (anti-bot interstitials, rate limits, slow
// loads, the OTP backend). Retry those: a genuine regression still fails every
// attempt and stays red, while an environmental blip self-heals. 0 to reproduce raw.
const retries = Number(process.env.E2E_RETRIES ?? 2);

export default defineConfig({
  testDir: ".",
  testMatch: /\.spec\.ts/,
  // Same module both ends, because it does the same thing both ends: bury the
  // browsers whose owning runner is gone (lib/browser-reaper.ts). At setup those
  // are a previous run's - Playwright's own SIGINT/SIGTERM teardown cannot cover
  // a SIGKILL'd runner, and its headed browser tree outlives it. At teardown the
  // spec workers have already exited, so anything of THIS run that escaped
  // `closeSession` is reapable too. A concurrent suite on the same checkout has
  // live workers and is left alone.
  globalSetup: "./lib/browser-reaper.ts",
  globalTeardown: "./lib/browser-reaper.ts",
  // The selector-drift probe runs extension-less on its own config/schedule.
  testIgnore: ["**/selector-drift/**"],
  fullyParallel: false,
  workers: 1,
  retries,
  // Retries exist for LIVE-surface flake (anti-bot walls, slow feeds, the OTP
  // backend). A spec that touches neither live sites nor the backend gets 0:
  // there an intermittent failure IS a product bug and must not self-heal into
  // "flaky but green".
  projects: [
    { name: "hermetic", testMatch: /coext-source\.spec\.ts$/, retries: 0 },
    { name: "live", testMatch: /\.spec\.ts$/, testIgnore: [/coext-source\.spec\.ts$/, "**/selector-drift/**"] },
  ],
  timeout: testTimeout,
  // Snapshot asserts (the a11y aria structures) run ONLY under CI on the
  // default channel - another browser channel or engine (E2E_BROWSER=firefox)
  // renders its own accessibility tree, and the diff would be engine noise
  // rather than a regression.
  ignoreSnapshots: !process.env.CI || !!process.env.E2E_CHROME_CHANNEL || !!process.env.E2E_BROWSER_EXECUTABLE_PATH || !!process.env.E2E_BROWSER,
  expect: {
    timeout: expectTimeout,
  },
  reporter: [
    ["list"],
    [
      "html",
      {
        open: "never",
        outputFolder: "test-results/e2e-html",
      },
    ],
    // For a machine-readable result with each skip/flaky/fail reason, point the
    // JSON reporter at a file via env. A CLI `--reporter=list,json` REPLACES this
    // config list entirely (verified on the pinned Playwright), so an inline
    // `outputFile` here would be ignored on exactly those runs - the env var
    // reaches the CLI-selected reporter too:
    //   PLAYWRIGHT_JSON_OUTPUT_FILE=test-results/e2e.json pnpm exec playwright test -c
    // e2e/playwright.config.ts --reporter=list,json
  ],
  use: {
    headless: false,
    viewport: { width: 1366, height: 900 },
    actionTimeout: 15_000,
    navigationTimeout: 60_000,
    screenshot: "only-on-failure",
    // The trace snapshotter re-serializes the page after every action, and the picker
    // renders the whole emoji palette at once - so one snapshot costs seconds on a heavy
    // site, and opening the picker with tracing on has been an order of magnitude slower
    // than with it off. Enough to push picker-heavy specs past their timeouts, in other
    // words. Record on the retry instead: the first attempt runs at full
    // speed, and a real failure still lands a full trace. With retries disabled
    // (E2E_RETRIES=0, the raw-reproduction mode) there is no retry to record on,
    // so keep the failing attempt's trace there.
    trace: retries > 0 ? "on-first-retry" : "retain-on-failure",
    video: process.env.E2E_VIDEO === "1" ? "retain-on-failure" : "off",
  },
});

function loadEnvFiles(): void {
  const shellEnvKeys = new Set(Object.keys(process.env));
  for (const [key, value] of Object.entries(loadE2eEnvFiles(extensionRoot))) {
    if (shellEnvKeys.has(key)) continue;
    process.env[key] = value;
  }
}
