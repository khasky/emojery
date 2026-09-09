// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pixel baselines for the surfaces the extension draws ITSELF - popup, auth,
// onboarding - where the DOM is ours end to end and a screenshot is therefore a
// stable contract. The live-site trigger is deliberately NOT here: the page
// behind it changes hourly, so a baseline of it would red-flag the site's
// content rather than our rendering (site-injection/theme-contrast/glyph-size
// cover that surface with measurements instead).
//
// Snapshots compare in CI only (`ignoreSnapshots` in playwright.config.ts), so
// the baselines that count are the CI platform's; a local run silently skips the
// comparison. To refresh them, run this file in CI with --update-snapshots.
//
// What is masked and why: the build stamp in the popup header carries the
// version, which changes every release and would invalidate every popup baseline.
import { expect, type Page, test } from "@playwright/test";
import * as ext from "./lib/extension";
import type { PopupThemeChoice } from "./lib/popup-settings";
import { BUILD_INFO_SELECTOR, CARD_SELECTOR, DEBUG_TAB_SELECTOR, HISTORY_DAY_SELECTOR, POPUP_SELECTOR } from "./lib/selectors";

// The narrowest the popup ever paints (`min-width: 360px`, popup.css) - the width
// a translation actually has to fit into.
const POPUP_VIEWPORT = { width: 360, height: 600 };
const THEMES: PopupThemeChoice[] = ["light", "dark"];

// The whole file drives extension pages, which Playwright Firefox cannot reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);
// Nothing here touches the network or an account, so a retry would only hide flake.
test.describe.configure({ retries: 0 });

// Park the pointer before a shot: a control left under the cursor paints its
// hover state, which depends on where the last click happened to land.
async function settleForShot(page: Page): Promise<void> {
  await page.mouse.move(0, 0);
}

async function shootPopup(popup: Page, name: string): Promise<void> {
  await settleForShot(popup);
  await expect(popup.locator(POPUP_SELECTOR)).toHaveScreenshot(name, { mask: [popup.locator(BUILD_INFO_SELECTOR)] });
}

async function openSizedPopup(context: ext.Session["context"]): Promise<Page> {
  const popup = await ext.openPopup(context);
  await popup.setViewportSize(POPUP_VIEWPORT);
  return popup;
}

test("popup surfaces hold their look in light and dark", async () => {
  const session = await ext.launchSession({ locale: "en-US" });
  try {
    for (const theme of THEMES) {
      await ext.setPopupTheme(session.context, theme);
      const popup = await openSizedPopup(session.context);
      try {
        await shootPopup(popup, `popup-settings-${theme}.png`);

        const perSite = popup.getByRole("checkbox", { name: ext.enMessage("sectionPerSite") });
        await perSite.check();
        await expect(popup.getByRole("searchbox", { name: ext.enMessage("filterSitesPlaceholder") })).toBeVisible();
        await shootPopup(popup, `popup-per-site-${theme}.png`);
        // Switching the section off clears the exclusions, so the next shot starts clean.
        await perSite.uncheck();

        await popup.getByRole("tab", { name: ext.enMessage("tabAccount") }).click();
        await expect(popup.getByRole("button", { name: ext.enMessage("signInBtn") })).toBeVisible();
        await shootPopup(popup, `popup-account-signed-out-${theme}.png`);

        await popup.getByRole("tab", { name: ext.enMessage("tabReport") }).click();
        await shootPopup(popup, `popup-report-signed-out-${theme}.png`);
      } finally {
        await popup.close().catch(() => {});
      }
    }

    // Debug last: revealing it adds a button to the header that every shot above
    // would otherwise have to include. The theme is set explicitly rather than
    // inherited from whatever the loop above left behind - the baseline is a dark one.
    await ext.setPopupTheme(session.context, "dark");
    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: ext.enMessage("settingDebug"), checked: true });
    const withDebug = await openSizedPopup(session.context);
    try {
      await withDebug.locator(DEBUG_TAB_SELECTOR).click();
      await expect(withDebug.locator(HISTORY_DAY_SELECTOR)).toContainText("0 queued");
      await shootPopup(withDebug, "popup-debug-queue-dark.png");
    } finally {
      await withDebug.close().catch(() => {});
    }
    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: ext.enMessage("settingDebug"), checked: false });
  } finally {
    await ext.closeSession(session);
  }
});

test("the sign-in and onboarding pages hold their look in light and dark", async () => {
  const session = await ext.launchSession({ locale: "en-US", keepOnboardingTab: true });
  try {
    const extensionId = await ext.resolveExtensionId(session.context);
    expect(extensionId, "the extension must load before its pages are shot").not.toBeNull();
    if (!extensionId) throw new Error("Missing Emojery extension id");

    for (const theme of THEMES) {
      // These pages resolve the palette once, at bootstrap - so the setting has to
      // be in place BEFORE the page is opened.
      await ext.setPopupTheme(session.context, theme);
      const page = await session.context.newPage();
      try {
        await page.goto(ext.extensionPageUrl(extensionId, "auth.html"));
        await expect(page.getByRole("heading", { name: ext.enMessage("authSignInTitle") })).toBeVisible();
        await settleForShot(page);
        await expect(page.locator(CARD_SELECTOR)).toHaveScreenshot(`auth-sign-in-${theme}.png`);

        await page.goto(ext.extensionPageUrl(extensionId, "onboarding.html"));
        await expect(page.getByRole("heading", { name: ext.enMessage("onboardingTitle") })).toBeVisible();
        await settleForShot(page);
        await expect(page.locator(CARD_SELECTOR)).toHaveScreenshot(`onboarding-${theme}.png`);
      } finally {
        await page.close().catch(() => {});
      }
    }
  } finally {
    await ext.closeSession(session);
  }
});

// German is the length stress test: its labels are the longest the catalogs ship,
// so this is where a row wraps or a control gets pushed out first.
test("the German popup and pages survive their longer labels", async () => {
  const session = await ext.launchSession({ locale: "de", keepOnboardingTab: true });
  try {
    const extensionId = await ext.resolveExtensionId(session.context);
    expect(extensionId).not.toBeNull();
    if (!extensionId) throw new Error("Missing Emojery extension id");

    const popup = await openSizedPopup(session.context);
    try {
      await shootPopup(popup, "popup-settings-de.png");
      await popup.getByRole("checkbox", { name: ext.localeMessage("de", "sectionPerSite") }).check();
      await shootPopup(popup, "popup-per-site-de.png");
    } finally {
      await popup.close().catch(() => {});
    }

    const page = await session.context.newPage();
    try {
      await page.goto(ext.extensionPageUrl(extensionId, "auth.html"));
      await expect(page.getByRole("heading", { name: ext.localeMessage("de", "authSignInTitle") })).toBeVisible();
      await settleForShot(page);
      await expect(page.locator(CARD_SELECTOR)).toHaveScreenshot("auth-sign-in-de.png");

      await page.goto(ext.extensionPageUrl(extensionId, "onboarding.html"));
      await expect(page.getByRole("heading", { name: ext.localeMessage("de", "onboardingTitle") })).toBeVisible();
      await settleForShot(page);
      await expect(page.locator(CARD_SELECTOR)).toHaveScreenshot("onboarding-de.png");
    } finally {
      await page.close().catch(() => {});
    }
  } finally {
    await ext.closeSession(session);
  }
});
