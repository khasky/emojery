// SPDX-License-Identifier: GPL-3.0-or-later
//
// Extension-less selector-drift config: same URL table and env chain as the
// main suite, but nothing is built or loaded - just a realistic Chromium
// visiting the scenario pages. Cheap enough to run on its own daily schedule.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";
import { loadE2eEnvFiles } from "../lib/load-env";

const __dirname = dirname(fileURLToPath(import.meta.url));
const extensionRoot = resolve(__dirname, "..", "..");

for (const [key, value] of Object.entries(loadE2eEnvFiles(extensionRoot))) {
  if (!(key in process.env)) process.env[key] = value;
}

export default defineConfig({
  testDir: ".",
  testMatch: /selector-drift\.spec\.ts/,
  // This probe mints no `run-*` profile of its own (no extension, no persistent
  // context), so the reaper never has one of ITS browsers to bury - it is wired
  // here so that whichever suite runs next is the one that clears a phantom the
  // main suite left behind. See lib/browser-reaper.ts.
  globalSetup: "../lib/browser-reaper.ts",
  globalTeardown: "../lib/browser-reaper.ts",
  fullyParallel: false,
  workers: 1,
  retries: 1,
  timeout: 120_000,
  reporter: [["list"], ["html", { open: "never", outputFolder: "../test-results/selector-drift-html" }]],
  use: {
    // Headed (xvfb in CI) with the automation flag hidden, mirroring the main
    // suite: the probe must see the page a real visitor gets, not a bot wall.
    headless: false,
    viewport: { width: 1366, height: 900 },
    navigationTimeout: 60_000,
    screenshot: "only-on-failure",
    launchOptions: { args: ["--disable-blink-features=AutomationControlled", "--mute-audio"] },
  },
});
