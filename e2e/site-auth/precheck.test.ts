// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fail-fast preconditions for the bridge suite. If these don't hold, every other
// flow would fail noisily - so we assert them once, with actionable messages.
//
// fx.setup already throws on these same invariants, so these tests cannot go
// red while it does its job - they are backstops that keep the
// invariants asserted should setup's own checks ever weaken.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bridgeFixture, gotoSettled, openPickerState, SETUP_HOOK_TIMEOUT_MS, siteAuthEnabled, waitForHost } from "./harness";
import { authContentUrl } from "./scenarios";

const fx = bridgeFixture();

// retry: 0 - these are fail-fast setup checks; retrying them only
// delays the actionable "not attached / not signed in" message by 3x.
(siteAuthEnabled() ? describe : describe.skip)("site-auth: precheck", { retry: 0 }, () => {
  beforeAll(fx.setup, SETUP_HOOK_TIMEOUT_MS);
  afterAll(fx.teardown);

  test("bridge drives a browser where Emojery is loaded", async () => {
    const b = fx.need();
    // The tab list proves nothing here: an attached extension-mode bridge sees only
    // its own tab. A mounted trigger does - a throwaway browser has no Emojery.
    await gotoSettled(b, authContentUrl("github"));
    expect(await waitForHost(b, "github"), "no Emojery trigger on GitHub - the bridge drove a browser without the staging build loaded; check the token, PLAYWRIGHT_MCP_BROWSER and E2E_MCP_URL").toBeGreaterThan(0);
  });

  test("Emojery extension is signed in (emoji grid opens)", async () => {
    const b = fx.need();
    // GitHub is a stable surface that always shows an Emojery trigger; the picker grid
    // opens only when the extension itself is signed in (else clicking opens
    // auth.html). This is independent of being logged into GitHub.
    await gotoSettled(b, authContentUrl("github"));
    const st = await openPickerState(b);
    expect(st.gridVisible, "Emojery picker grid did not open - sign in to Emojery through a provider in the popup of this Chrome").toBe(true);
    await b.press("Escape");
  });
});
