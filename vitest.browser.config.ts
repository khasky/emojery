// SPDX-License-Identifier: GPL-3.0-or-later
//
// Run the content-script UI in REAL WebKit and Gecko engines (Vitest browser mode +
// Playwright) - the cheap barrier for engine-specific rendering/CSS/shadow-DOM
// regressions jsdom can't see and Chromium e2e won't flag. NOT a true Safari/Firefox
// extension e2e: it renders against a faked extension runtime (src/test/chrome-shim.ts),
// so packaging, the background context and real chrome.* APIs stay with the e2e suites
// (Firefox: E2E_BROWSER=firefox) and, for Safari, a real Mac.
// Run: pnpm run test:browser - one-time prereq: pnpm exec playwright install webkit firefox

import preact from "@preact/preset-vite";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Preact JSX transform, same as the production build (wxt.config.ts).
  plugins: [preact() as never],
  // Nothing here imports from `public/`, and the chrome shim fetches the shipped emoji
  // data by its real path (`/public/emoji-data/*.json`, see src/test/chrome-shim.ts) -
  // a configured public dir would serve those files at `/` instead.
  publicDir: false,
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
  test: {
    include: ["src/**/*.browser.test.{ts,tsx}"],
    // The provider launches WebKit and Gecko itself, outside the profile the e2e
    // suites stamp, so the reaper's dead-parent rule is what covers them - and it
    // only ever fires against a PREVIOUS run's leftovers, since this run's own
    // browsers still have a live parent while it is teardown time here.
    globalSetup: ["./e2e/lib/browser-reaper.ts"],
    browser: {
      enabled: true,
      provider: playwright(),
      // CI-friendly. Drop to false to watch it render in a real WebKit window.
      headless: true,
      // A literal address instead of the default `localhost`, which is two endpoints on
      // Windows: `dns.lookup` returns ::1 before 127.0.0.1, so Node binds the tester
      // server to ::1 ONLY - and Firefox, resolving the same name in the page URL, can
      // pick the IPv4 one and get a closed port. That killed 3 of 4 local runs mid-suite
      // with `page.goto: NS_ERROR_CONNECTION_REFUSED` (WebKit and Linux CI never hit it).
      // A literal host takes DNS out of the URL, so both engines dial what Node bound.
      api: { host: "127.0.0.1" },
      // Pinned viewport: picker placement asserts depend on window height
      // (mirrored layout flips on available room) - an unpinned default made
      // those checks machine-dependent.
      instances: [
        { browser: "webkit", viewport: { width: 1280, height: 900 } },
        { browser: "firefox", viewport: { width: 1280, height: 900 } },
      ],
    },
  },
});
