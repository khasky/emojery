// SPDX-License-Identifier: GPL-3.0-or-later
//
// The open picker popover must stay fully on-screen under viewport
// stress: a narrow (~400px) window and browser zoom (50% / 200%). The popover
// is position:fixed and clamps itself to the viewport (src/ui/picker.tsx), so these
// assert it never spills past the left/top/right edge. Runs on GitHub (single
// target, no platform login); opening the tray needs an Emojery sign-in.
import { expect, test } from "@playwright/test";
import * as ext from "./lib/extension";

const REQUIRES_OTP = ext.otpSkipReason("layout checks");

// Both cases sign in through auth.html (the tray only opens signed-in), which Playwright Firefox cannot reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);

type Fit = NonNullable<Awaited<ReturnType<typeof ext.openPickerViewportFit>>>;

// The popover may be taller than a short viewport (it scrolls internally), so we
// assert only the horizontal fit + that it starts on-screen - never off an edge.
const SUBPIXEL_TOLERANCE_PX = 2;

function expectOnScreen(fit: Fit, label: string): void {
  expect(fit.rect.left, `${label}: left edge on-screen`).toBeGreaterThanOrEqual(-SUBPIXEL_TOLERANCE_PX);
  expect(fit.rect.top, `${label}: top edge on-screen`).toBeGreaterThanOrEqual(-SUBPIXEL_TOLERANCE_PX);
  expect(fit.rect.right, `${label}: right edge within viewport`).toBeLessThanOrEqual(fit.vw + SUBPIXEL_TOLERANCE_PX);
}

test("picker tray fits a narrow ~400px viewport", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    await ext.signIn(session.context);
    const page = await ext.openGithub(session.context);
    await page.setViewportSize({ width: 400, height: 880 });
    // Give the narrowed page a beat to reflow and re-anchor the trigger before reading the mount.
    await page.waitForTimeout(500);
    expect(await ext.firstMountedKey(page), "a GitHub Emojery host should mount").not.toBeNull();

    const fit = await ext.openPickerViewportFit(page);
    expect(fit, "picker popover should open").not.toBeNull();
    if (fit) expectOnScreen(fit, "narrow 400px");
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

test("picker tray stays on-screen at 50% and 200% zoom", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    const page = await ext.signedInGithubPage(session.context);

    for (const zoom of ["0.5", "2"]) {
      await page.evaluate((z) => document.documentElement.style.setProperty("zoom", z), zoom);
      // Waited, not polled: `zoom` fires no resize event, so nothing observable announces
      // that the trigger has re-anchored to its resized row - this is that settle.
      await page.waitForTimeout(500);

      const fit = await ext.openPickerViewportFit(page);
      expect(fit, `popover should open at ${zoom}x zoom`).not.toBeNull();
      if (fit) expectOnScreen(fit, `zoom ${zoom}`);

      await page.evaluate(() => document.documentElement.style.removeProperty("zoom"));
      // Same silent re-anchor on the way back to 1x, before the next zoom is applied.
      await page.waitForTimeout(300);
    }
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});
