// SPDX-License-Identifier: GPL-3.0-or-later
//
// Fail-fast preconditions for the bridge suite. If these don't hold, every other
// flow would fail noisily - so we assert them once, with actionable messages.
//
// fx.setup already throws on these same invariants, so these tests cannot go
// red while it does its job - they are deliberate backstops that keep the
// invariants asserted should setup's own checks ever weaken.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bridgeFixture, gotoSettled, openPickerState, SETUP_HOOK_TIMEOUT_MS, siteAuthEnabled } from "./harness";
import { authContentUrl } from "./scenarios";

const fx = bridgeFixture();

// retry: 0 - these are deliberately fail-fast setup checks; retrying them only
// delays the actionable "not attached / not signed in" message by 3x.
(siteAuthEnabled() ? describe : describe.skip)("site-auth: precheck", { retry: 0 }, () => {
  beforeAll(fx.setup, SETUP_HOOK_TIMEOUT_MS);
  afterAll(fx.teardown);

  test("bridge is attached to the real, human-launched Chrome", async () => {
    const b = fx.need();
    const urls = await b.tabUrls();
    // A single about:blank means the server launched its own browser instead of
    // attaching to yours (token/extension misconfig).
    expect(urls.length === 1 && urls[0] === "about:blank", "bridge launched a throwaway browser; check the Playwright Extension + token").toBe(false);
    expect(urls.length).toBeGreaterThan(0);
  });

  test("Emojery extension is signed in (emoji grid opens)", async () => {
    const b = fx.need();
    // GitHub is a stable surface that always shows an Emojery trigger; the picker grid
    // opens only when the extension itself is signed in (else clicking opens
    // auth.html). This is independent of being logged into GitHub.
    await gotoSettled(b, authContentUrl("github"));
    const st = await openPickerState(b);
    expect(st.gridVisible, "Emojery picker grid did not open - complete the Emojery OTP sign-in in this Chrome").toBe(true);
    await b.press("Escape");
  });
});
