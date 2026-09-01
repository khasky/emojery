// SPDX-License-Identifier: GPL-3.0-or-later

import { type BrowserContext, type ElementHandle, expect, type Page, test } from "@playwright/test";
import { IG_PUBLIC_ACTION_ICON_PATH_PREFIXES } from "../src/adapters/instagram";
import { authConfigured, closeSession, ensureSignedOut, envUrl, extensionPageUrl, FIREFOX_NO_EXTENSION_PAGES, isFirefoxRun, localeMessage, openPopup, otpSkipReason, REACTIONS, removeProfileUnlessKept, resolveExtensionId, searchTermFor } from "./lib/extension";
import { expectLocalizedNativePlacement, type I18nLocaleCase, type LocalizedAdapterCheck } from "./lib/localized-placement";
import { debugEvidence, handleKnownInterstitials, hasLoginWallText, isNoActionSurface, safeGoto, safeReload, settleFullLoad, settlePage, waitForDisabledSiteEvidence, waitForMountEvidence } from "./lib/page-settle";
import {
  clickFirstUnselectedReactionOption,
  emojiGridOptionTexts,
  expectFocusedElementHasVisibleFocusRing,
  expectFocusedEmojeryTrigger,
  expectFocusedEmojiGridOption,
  expectVisibleEmojiGridOption,
  expectVisibleSearchFocused,
  fillVisibleEmojiSearch,
  findMatchingEmojeryTrigger,
  firstMatchingEvidenceTargetKey,
  pickReactionOnMatchingHost,
  waitForMountedTargetKey,
  waitForVisibleEmojeryTrigger,
} from "./lib/picker-probes";
import { authPageFromUserAction, expectHistoryRowCount, expectHistorySearchFiltersReaction, expectHistorySignedOut, expectLatestHistoryReactions, openLatestHistoryReactionPage, setReplaceNativeFromPopup, setSiteEnabledFromPopup, signInTestAccount, waitForReactionOnHistoryPage } from "./lib/popup-probes";
import { DEEP_QUERY_ALL_SRC } from "./lib/probe-src";
import { clearReactionOnTarget, clickReactionBySearchOnTarget, expectPickerClosed, expectReactionOptionSelected, expectSelectedReaction, expectVisibleReactionOptions, pickReactionBySearchOnTarget } from "./lib/reaction-actions";
import type { MountEvidence, SupportedSiteScenario } from "./lib/site-evidence";
import { keyMatchDiagnostic, launchE2eBrowserSession, settleAndRequireMount, skipWithShot } from "./lib/site-session";
import { isBlockUrl } from "./lib/site-walls";
import { SUPPORTED_SITE_SCENARIOS } from "./supported-sites";

interface SiteCheckOptions {
  replaceNative?: boolean;
  /** After the replace-on checks pass, toggle the setting back OFF via the
   *  popup and assert every hidden native control on the LIVE page is restored
   *  in place (no reload). Regression: Reddit keeps its vote block inside
   *  shreddit-post's shadow DOM, where a non-piercing restore sweep never found
   *  the hidden marker - natives stayed hidden until a full page reload. */
  verifyRestoreAfterReplaceOff?: boolean;
  verifyAuthedReactionHistory?: boolean;
  verifyPerSiteToggle?: boolean;
  verifyUnauthAuthClick?: boolean;
  colorScheme?: "light" | "dark";
}

const supportedSiteScenarios: SupportedSiteScenario[] = SUPPORTED_SITE_SCENARIOS.map((scenario) => ({ ...scenario, url: envUrl(scenario.urlKey) }));

let context: BrowserContext;
let generatedUserDataDir: string | null = null;

test.beforeAll(async () => {
  const session = await launchE2eBrowserSession();
  context = session.context;
  generatedUserDataDir = session.generatedUserDataDir;
});

test.afterAll(async () => {
  const keepOpenMs = Number(process.env.E2E_KEEP_OPEN_MS ?? 0);
  if (keepOpenMs > 0) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, keepOpenMs));
  }
  await context?.close();
  if (generatedUserDataDir) await removeProfileUnlessKept(generatedUserDataDir);
});

test("extension is loaded in the browser profile", async () => {
  // The load proof here is opening auth.html; on firefox the placement tests
  // themselves are the load proof (a mount = the temporary add-on is running).
  test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);
  const extensionId = await resolveExtensionId(context);
  expect(extensionId, "Emojery must be loaded as an unpacked extension before site checks run").not.toBeNull();
  if (!extensionId) return;

  const auth = await context.newPage();
  try {
    await auth.goto(extensionPageUrl(extensionId, "auth.html"));
    await expect(auth.locator("#email-input")).toBeVisible();
  } finally {
    await auth.close().catch(() => {});
  }
});

test("private window: supported site button opens auth.html", async () => {
  test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);
  const session = await launchE2eBrowserSession({
    incognito: true,
    useGeneratedUserDataDir: true,
  });
  const site = pickerBehaviorScenario();
  const page = await session.context.newPage();
  let authPage: Page | null = null;
  try {
    const evidence = await openSupportedSitePage(page, site);
    authPage = await verifyUnauthClickOpensAuthTab(session.context, page, site, evidence);
    expect(authPage, "A private-window supported-site click should open visible auth.html").not.toBeNull();
    if (!authPage) return;
    await expect(authPage.locator("#email-input")).toBeVisible();
  } finally {
    await authPage?.close().catch(() => {});
    await page.close().catch(() => {});
    await closeSession(session);
  }
});

test.describe("shared picker behavior", () => {
  test("github: supports toggle-off, switch reaction, and cross-tab sync", async () => {
    test.skip(!authConfigured(), otpSkipReason("authed picker behavior e2e checks"));
    test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);

    const session = await launchE2eBrowserSession();
    const site = pickerBehaviorScenario();
    const pageOne = await session.context.newPage();
    const pageTwo = await session.context.newPage();
    try {
      await ensureSignedOut(session.context);
      await expectHistorySignedOut(session.context);
      const evidence = await signInOnSupportedSite(session.context, pageOne, site);
      // A throwaway profile starts with no local history, and signing in through
      // the gate casts exactly the one reaction it was holding - so anything but
      // a single row here means the account inherited someone else's.
      if (session.generatedUserDataDir) {
        await expectHistoryRowCount(session.context, 1);
      }
      const targetKey = firstMatchingEvidenceTargetKey(site, evidence);
      expect(targetKey, debugEvidence(evidence)).not.toBeNull();
      if (!targetKey) return;

      await clearReactionOnTarget(pageOne, site, targetKey);
      await expectReactionOptionSelected(pageOne, site, targetKey, REACTIONS.heart, false);

      const firstPick = await clickReactionBySearchOnTarget(pageOne, site, targetKey, REACTIONS.heart, searchTermFor(REACTIONS.heart));
      await expectSelectedReaction(pageOne, site, targetKey, REACTIONS.heart);
      await expectLatestHistoryReactions(session.context, [REACTIONS.heart]);

      await clickReactionBySearchOnTarget(pageOne, site, targetKey, REACTIONS.heart, searchTermFor(REACTIONS.heart));
      await expectReactionOptionSelected(pageOne, site, targetKey, REACTIONS.heart, false);
      await expectSelectedReaction(pageOne, site, targetKey, null);
      await expectLatestHistoryReactions(session.context, [REACTIONS.heart]);

      const { page: removedHistoryPage, shouldClose: shouldCloseRemovedHistory } = await openLatestHistoryReactionPage(session.context, firstPick);
      try {
        await expectSelectedReaction(removedHistoryPage, site, targetKey, null);
      } finally {
        if (shouldCloseRemovedHistory) {
          await removedHistoryPage.close().catch(() => {});
        }
      }

      await pickReactionBySearchOnTarget(pageOne, site, targetKey, REACTIONS.heart, searchTermFor(REACTIONS.heart));
      await expectSelectedReaction(pageOne, site, targetKey, REACTIONS.heart);
      await pickReactionBySearchOnTarget(pageOne, site, targetKey, REACTIONS.fire, searchTermFor(REACTIONS.fire));
      await expectSelectedReaction(pageOne, site, targetKey, REACTIONS.fire);
      await expectLatestHistoryReactions(session.context, [REACTIONS.fire, REACTIONS.heart]);
      await expectHistorySearchFiltersReaction(session.context, REACTIONS.fire);

      await openSupportedSitePage(pageTwo, site);
      await waitForMountedTargetKey(pageTwo, targetKey, site);
      await expectSelectedReaction(pageTwo, site, targetKey, REACTIONS.fire);

      await pickReactionBySearchOnTarget(pageOne, site, targetKey, REACTIONS.heart, searchTermFor(REACTIONS.heart));
      await expectSelectedReaction(pageOne, site, targetKey, REACTIONS.heart);
      await expectSelectedReaction(pageTwo, site, targetKey, REACTIONS.heart);

      await pickReactionBySearchOnTarget(pageOne, site, targetKey, REACTIONS.fire, searchTermFor(REACTIONS.fire));
      await expectSelectedReaction(pageOne, site, targetKey, REACTIONS.fire);
      await expectSelectedReaction(pageTwo, site, targetKey, REACTIONS.fire);
    } finally {
      await ensureSignedOut(session.context).catch(() => {});
      await pageTwo.close().catch(() => {});
      await pageOne.close().catch(() => {});
      await closeSession(session);
    }
  });

  test("github: picker supports keyboard operation with reduced motion", async () => {
    test.skip(!authConfigured(), otpSkipReason("authed keyboard e2e checks"));
    test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);

    const session = await launchE2eBrowserSession();
    const site = pickerBehaviorScenario();
    const page = await session.context.newPage();
    try {
      await page.emulateMedia({ reducedMotion: "reduce" });
      // A pick sticks only signed-in; start from a cleared target so the
      // keyboard picks assert deterministically across re-runs.
      await ensureSignedOut(session.context);
      const evidence = await signInOnSupportedSite(session.context, page, site);
      const targetKey = firstMatchingEvidenceTargetKey(site, evidence);
      expect(targetKey, debugEvidence(evidence)).not.toBeNull();
      if (!targetKey) return;
      await clearReactionOnTarget(page, site, targetKey);

      const trigger = await waitForVisibleEmojeryTrigger(page, site, targetKey);
      expect(trigger, debugEvidence(evidence)).not.toBeNull();
      if (!trigger) return;
      try {
        await trigger.focus();
        await page.keyboard.press(" ");
        await expectVisibleReactionOptions(page);
        await expectVisibleSearchFocused(page);

        await page.keyboard.press("Escape");
        await expectPickerClosed(page);
        await expectFocusedEmojeryTrigger(page, targetKey);

        await trigger.focus();
        await page.keyboard.press("Enter");
        await expectVisibleReactionOptions(page);
        await expectVisibleSearchFocused(page);

        await page.keyboard.press("Escape");
        await expectPickerClosed(page);
        await expectFocusedEmojeryTrigger(page, targetKey);

        await trigger.focus();
        await page.keyboard.press("Enter");
        await expectVisibleReactionOptions(page);
        // Bottom-right dead zone of whatever viewport this session got, so an
        // outside-click dismissal isn't pinned to the 1366x900 launch size.
        const viewport = page.viewportSize() ?? { width: 1366, height: 900 };
        await page.mouse.click(viewport.width - 36, viewport.height - 30);
        await expectPickerClosed(page);

        await trigger.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
        await trigger.focus();
        await page.keyboard.press("Enter");
        await expectVisibleReactionOptions(page);
        await page.mouse.wheel(0, 500);
        await expectPickerClosed(page);

        await trigger.focus();
        await page.keyboard.press("ArrowDown");
        await expectVisibleReactionOptions(page);
        const gridOptions = await emojiGridOptionTexts(page);
        expect(gridOptions.length, "Picker should expose multiple emoji choices").toBeGreaterThanOrEqual(2);
        await page.keyboard.press("ArrowDown");
        await expectFocusedEmojiGridOption(page, gridOptions[0]!);
        await expectFocusedElementHasVisibleFocusRing(page);
        await page.keyboard.press("ArrowRight");
        await expectFocusedEmojiGridOption(page, gridOptions[1]!);
        await page.keyboard.press("ArrowLeft");
        await expectFocusedEmojiGridOption(page, gridOptions[0]!);
        await page.keyboard.press("End");
        await expectFocusedEmojiGridOption(page, gridOptions[gridOptions.length - 1]!);
        await page.keyboard.press("Home");
        await expectFocusedEmojiGridOption(page, gridOptions[0]!);
        const keyboardPickedReaction = gridOptions[0] === REACTIONS.heart ? gridOptions[1]! : gridOptions[0]!;
        if (keyboardPickedReaction !== gridOptions[0]) {
          await page.keyboard.press("ArrowRight");
          await expectFocusedEmojiGridOption(page, keyboardPickedReaction);
        }
        await page.keyboard.press(" ");
        await expectSelectedReaction(page, site, targetKey, keyboardPickedReaction);

        const reactedTrigger = await waitForVisibleEmojeryTrigger(page, site, targetKey);
        expect(reactedTrigger, "Selected reaction should keep a visible trigger").not.toBeNull();
        if (!reactedTrigger) return;
        try {
          await reactedTrigger.focus();
        } finally {
          await reactedTrigger.dispose().catch(() => {});
        }
        await page.keyboard.press("ArrowDown");
        await expectVisibleReactionOptions(page);
        await fillVisibleEmojiSearch(page, "red heart");
        await expectVisibleEmojiGridOption(page, REACTIONS.heart);
        await page.keyboard.press("Tab");
        await expectFocusedEmojiGridOption(page, REACTIONS.heart);
        await page.keyboard.press("Enter");
        await expectSelectedReaction(page, site, targetKey, REACTIONS.heart);
        await expectFocusedEmojeryTrigger(page, targetKey);
      } finally {
        await trigger.dispose().catch(() => {});
      }
    } finally {
      await ensureSignedOut(session.context).catch(() => {});
      await page.close().catch(() => {});
      await closeSession(session);
    }
  });
});

const i18nLocaleCases: I18nLocaleCase[] = [
  { locale: "ru", query: "\u043B\u044E\u0431\u043E\u0432\u044C" },
  { locale: "de", query: "Liebe" },
  { locale: "ja", query: "\u611B" },
];

const localizedAdapterChecks: LocalizedAdapterCheck[] = [
  {
    site: "x",
    label: "X status detail",
    labelPatterns: {
      ru: ["\u043D\u0440\u0430\u0432"],
      de: ["gef\u00E4llt", "mag ich"],
      ja: ["\u3044\u3044\u306D"],
    },
  },
  {
    site: "threads",
    label: "Threads post detail",
    labelPatterns: {
      ru: ["\u043D\u0440\u0430\u0432"],
      de: ["gef\u00E4llt", "mag ich"],
      ja: ["\u3044\u3044\u306D"],
    },
    maxHorizontalDistance: 260,
  },
  {
    site: "youtube",
    label: "YouTube watch actions",
    labelPatterns: {
      ru: ["\u043D\u0440\u0430\u0432", "\u043F\u043E\u0434\u0435\u043B\u0438\u0442\u044C\u0441\u044F"],
      de: ["gef\u00E4llt", "mag ich", "teilen"],
      ja: ["\u9AD8\u304F\u8A55\u4FA1", "\u5171\u6709"],
    },
    maxHorizontalDistance: 520,
  },
  {
    site: "facebook",
    label: "Facebook post detail",
    labelPatterns: {
      ru: ["\u043D\u0440\u0430\u0432"],
      de: ["gef\u00E4llt"],
      ja: ["\u3044\u3044\u306D"],
    },
  },
  {
    site: "instagram",
    label: "Instagram public post",
    labelPatterns: {
      ru: ["\u043D\u0440\u0430\u0432"],
      de: ["gef\u00E4llt", "mag ich"],
      ja: ["\u3044\u3044\u306D"],
    },
    maxHorizontalDistance: 280,
  },
];

for (const localeCase of i18nLocaleCases) {
  test(`i18n: popup strings and emoji search work with --lang=${localeCase.locale}`, async () => {
    test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);
    test.setTimeout(Number(process.env.E2E_I18N_TEST_TIMEOUT_MS ?? 420_000));

    const session = await launchE2eBrowserSession({ locale: localeCase.locale });
    const site = pickerBehaviorScenario();
    const popup = await openPopup(session.context);
    const page = await session.context.newPage();
    try {
      await expect(
        popup.getByRole("tab", {
          name: localeMessage(localeCase.locale, "tabSettings"),
        }),
      ).toBeVisible();
      await expect(
        popup.getByRole("tab", {
          name: localeMessage(localeCase.locale, "tabHistory"),
        }),
      ).toBeVisible();
      await expect(
        popup.getByRole("tab", {
          name: localeMessage(localeCase.locale, "tabAccount"),
        }),
      ).toBeVisible();
      await expect(
        popup
          .getByText(localeMessage(localeCase.locale, "settingEnabled"), {
            exact: true,
          })
          .first(),
      ).toBeVisible();

      await page.emulateMedia({ reducedMotion: "reduce" });
      for (const adapterCheck of localizedAdapterChecks) {
        const localizedSite = localizedAdapterScenario(adapterCheck);
        const localizedEvidence = await openSupportedSitePage(page, localizedSite);
        await expectLocalizedNativePlacement(page, localizedSite, adapterCheck, localeCase.locale, localizedEvidence);
      }

      // The localized emoji search + pick needs a real signed-in reaction, so it
      // runs only when the test credentials are configured - the always-on
      // popup-string and localized-placement checks above stay unauthenticated.
      if (authConfigured()) {
        await ensureSignedOut(session.context, localeCase.locale);
        const evidence = await signInOnSupportedSite(session.context, page, site, localeCase.locale);
        const targetKey = firstMatchingEvidenceTargetKey(site, evidence);
        expect(targetKey, debugEvidence(evidence)).not.toBeNull();
        if (targetKey) {
          await clearReactionOnTarget(page, site, targetKey);
          await pickReactionBySearchOnTarget(page, site, targetKey, REACTIONS.heart, localeCase.query);
          await expectSelectedReaction(page, site, targetKey, REACTIONS.heart);
        }
      }
    } finally {
      await ensureSignedOut(session.context, localeCase.locale).catch(() => {});
      await page.close().catch(() => {});
      await popup.close().catch(() => {});
      await closeSession(session);
    }
  });
}

// Instagram's action icons carry every shipped UI locale - the EN/RU/UA stems
// behind them cover 3 of the 26, so a glyph redesign would strand the rest with
// no failing test anywhere. Pin the shipped prefixes against the live post.
test("instagram: shipped action-icon paths still match the live post", async () => {
  const site = supportedSiteScenarios.find((scenario) => scenario.urlKey === "INSTAGRAM_POST");
  expect(site, "the INSTAGRAM_POST scenario must stay in supported-sites.ts").toBeDefined();
  if (!site) return;

  const page = await context.newPage();
  try {
    const navOk = await safeGoto(page, site.url);
    await settlePage(page, site);
    await skipWithShot(page, site, !navOk || isBlockUrl(page.url()), `Instagram served an anti-bot shell, no icons to read: ${page.url()}`, "instagram-icon-paths-wall");
    const missing = await page.evaluate((prefixes) => {
      const paths = Array.from(document.querySelectorAll("svg[aria-label] path[d]")).map((path) => (path.getAttribute("d") ?? "").replace(/\s+/g, " "));
      return prefixes.filter((prefix) => !paths.some((pathData) => pathData.startsWith(prefix)));
    }, IG_PUBLIC_ACTION_ICON_PATH_PREFIXES);
    expect(missing, "Instagram redesigned an action icon - refresh the prefixes in src/adapters/instagram.ts").toEqual([]);
  } finally {
    await page.close().catch(() => {});
  }
});

// Always-on unauth coverage - the state a real default visitor gets: default
// settings (`replaceNative=false`), no platform login, no Emojery sign-in.
// Asserts the trigger mounts in the right place (no duplicate) AND that
// clicking the visible trigger opens auth.html.
for (const site of supportedSiteScenarios) {
  test(`${site.site}: ${site.label} default unauth placement and auth-click`, async () => {
    const isolatedSession = site.isolatedContext && !process.env.E2E_USER_DATA_DIR ? await launchE2eBrowserSession() : null;
    const activeContext = isolatedSession?.context ?? context;
    try {
      await verifySupportedSiteInjection(activeContext, site, {
        // Placement is still fully asserted on firefox; only the auth-tab click
        // check needs a juggler-visible moz-extension page.
        verifyUnauthAuthClick: !isFirefoxRun(),
      });
    } finally {
      if (isolatedSession) await closeSession(isolatedSession);
    }
  });
}

// Multi-language logged-out coverage for X. Signed out, X exposes NO data-testids; the
// adapter finds the action row and Like control by each action's stable,
// language-INDEPENDENT `svg[data-icon]` (the `xLabels` registry in src/adapters/x.ts).
// Running the real feed in several languages keeps detection from regressing to an
// enumerated-language list (verified live on x.com/romero: ru/uk/de/ja/zh all mount on
// icon-heart). The CJK pair is the load-bearing half - unit coverage proves the stems miss
// there by design (action-labels.test.ts), so a mount here is the icon path's doing.
function xProfileFeedScenario(): SupportedSiteScenario {
  const site = supportedSiteScenarios.find((scenario) => scenario.site === "x" && scenario.label === "X profile feed");
  if (!site) throw new Error("Missing X profile feed scenario");
  return site;
}
for (const locale of ["ru-RU", "uk-UA", "de-DE", "ja-JP", "zh-CN"]) {
  test(`x: X profile feed mounts logged-out in ${locale} (language-independent icon)`, async () => {
    const session = await launchE2eBrowserSession({ locale });
    try {
      await verifySupportedSiteInjection(session.context, xProfileFeedScenario(), {});
    } finally {
      await closeSession(session);
    }
  });
}

// Theme coverage for X's logged-out (icon-based) mount. The action icons are
// theme-INDEPENDENT (the same data-icon in light and dark, verified live), and
// logged-out X follows the system color scheme - so the picker must mount and
// place correctly in BOTH themes. Verified here in the site-injection harness
// (which reliably reveals X's action row, unlike the contrast harness).
for (const colorScheme of ["light", "dark"] as const) {
  test(`x: X profile feed mounts logged-out in ${colorScheme} theme`, async () => {
    const session = await launchE2eBrowserSession();
    try {
      await verifySupportedSiteInjection(session.context, xProfileFeedScenario(), {
        colorScheme,
      });
    } finally {
      await closeSession(session);
    }
  });
}

for (const site of supportedSiteScenarios) {
  test(`${site.site}: ${site.label} handles auth, reaction history, and per-site toggle`, async () => {
    test.skip(!authConfigured(), otpSkipReason("authed site e2e checks"));
    test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);
    // The authed flow chains sign-in (with OTP retry) and up to three
    // mount-evidence waits - initial load, post-sign-in reload, history URL -
    // so a slow-but-working anti-bot shell overruns the 120s default: Reddit's
    // js_challenge, and worst of all Amazon, whose "Continue shopping"
    // interstitial fires on all three loads (~246s live). A walled page skips early.
    test.setTimeout(Number(process.env.E2E_AUTHED_SITE_TIMEOUT_MS ?? 420_000));

    const isolatedSession = site.isolatedContext && !process.env.E2E_USER_DATA_DIR ? await launchE2eBrowserSession() : null;
    try {
      await verifySupportedSiteInjection(isolatedSession?.context ?? context, site, {
        verifyAuthedReactionHistory: true,
        verifyPerSiteToggle: true,
        verifyUnauthAuthClick: true,
      });
    } finally {
      if (isolatedSession) await closeSession(isolatedSession);
    }
  });
}

// Coverage exception: a scenario with `expectHiddenNativeOnReplace: false`
// (Amazon CA) runs this case as a plain placement re-run - the hidden-native
// assert, the `replacedNativeInvisibleSelectors` check and the
// restore-after-off leg all sit behind `expectHiddenNative`. So a total
// replace-native regression on that scenario would not turn this test red;
// the Amazon US scenario is the one that actually pins replacement.
for (const site of supportedSiteScenarios) {
  test(`${site.site}: ${site.label} replaces native buttons after popup toggle`, async () => {
    test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);
    const isolatedSession = process.env.E2E_USER_DATA_DIR ? null : await launchE2eBrowserSession();
    const activeContext = isolatedSession?.context ?? context;
    try {
      await setReplaceNativeFromPopup(activeContext, true);
      try {
        await verifySupportedSiteInjection(activeContext, site, { replaceNative: true, verifyRestoreAfterReplaceOff: true });
      } finally {
        // The in-test restore only runs on the expectHiddenNative path, so an
        // early test.skip - or a scenario with expectHiddenNativeOnReplace:false -
        // used to leave the setting ON. With E2E_USER_DATA_DIR the profile
        // outlives the run and would poison the next scenario.
        await setReplaceNativeFromPopup(activeContext, false).catch(() => {});
      }
    } finally {
      if (isolatedSession) await closeSession(isolatedSession);
    }
  });
}

async function verifySupportedSiteInjection(browserContext: BrowserContext, site: SupportedSiteScenario, options: SiteCheckOptions = {}): Promise<void> {
  const page = await browserContext.newPage();
  let authPage: Page | null = null;
  let signedIn = false;
  try {
    if (options.colorScheme) {
      await page.emulateMedia({ colorScheme: options.colorScheme });
    }
    if (options.verifyAuthedReactionHistory) {
      await ensureSignedOut(browserContext);
    }

    const navOk = await safeGoto(page, site.url);
    const expectHiddenNative = !!options.replaceNative && site.expectHiddenNativeOnReplace !== false;
    const evidence = await settleAndRequireMount(page, site, { navOk, phase: "initial", expectHiddenNative });
    if (site.maxHosts !== undefined) {
      expect(evidence.visibleHostCount, debugEvidence(evidence)).toBeLessThanOrEqual(site.maxHosts);
      expect(evidence.visibleMatchingHostCount, debugEvidence(evidence)).toBeLessThanOrEqual(site.maxHosts);
    }
    if (expectHiddenNative) {
      // replaceNative leg only: a login-walled/anti-bot shell has no real native to hide - skip
      // that leg, keep the mount asserts.
      await skipWithShot(page, site, (isBlockUrl(evidence.url) || hasLoginWallText(evidence)) && evidence.hiddenNativeCount === 0, `Native replacement not verifiable on ${site.site}'s anti-bot / login-wall shell (host mounted + placed, native login-gated): ${debugEvidence(evidence)}`, "replacenative-challenge-shell");
      expect(evidence.hiddenNativeCount, debugEvidence(evidence)).toBeGreaterThan(0);
      if (site.replacedNativeInvisibleSelectors?.length) {
        const visibleReplaced = await page.evaluate((selectors) => {
          return selectors
            .flatMap((sel) => Array.from(document.querySelectorAll<HTMLElement>(sel)))
            .filter((el) => {
              const rect = el.getBoundingClientRect();
              return rect.width > 0 && rect.height > 0 && getComputedStyle(el).display !== "none";
            }).length;
        }, site.replacedNativeInvisibleSelectors);
        expect(visibleReplaced, `replaced native control still visible under replaceNative: ${debugEvidence(evidence)}`).toBe(0);
      }
      if (options.verifyRestoreAfterReplaceOff) {
        await setReplaceNativeFromPopup(browserContext, false);
        // The settings watcher restores in place - poll the live page (shadow-
        // piercing) until no hidden marker remains, WITHOUT reloading.
        const restored = await page
          .waitForFunction(
            `(() => {
              ${DEEP_QUERY_ALL_SRC}
              return deepQueryAll('[data-khasky-emojery-hidden="1"]').length === 0;
            })()`,
            undefined,
            { timeout: 15_000 },
          )
          .then(
            () => true,
            () => false,
          );
        expect(restored, `hidden native controls not restored after toggling replace-native OFF: ${debugEvidence(evidence)}`).toBe(true);
      }
    }
    expect(evidence.placementOk, debugEvidence(evidence)).toBe(true);
    expect(evidence.missingRequiredHostAncestors, debugEvidence(evidence)).toHaveLength(0);
    // Visual-correctness invariant beyond proximity: one target key on more than
    // one connected anchor is a duplicate/stolen-host bug. The softer signals stay
    // evidence-only - `nativeSelectors` are too coarse to tell "beside" from
    // "inside" (YouTube legitimately reports full overlap), so asserting them false-fails.
    expect(evidence.duplicateMatchingKeys, `A target key must not appear on more than one connected anchor. ${debugEvidence(evidence)}`).toHaveLength(0);
    if (options.verifyUnauthAuthClick) {
      authPage = await verifyUnauthClickOpensAuthTab(browserContext, page, site, evidence);
    }
    if (options.verifyAuthedReactionHistory) {
      expect(authPage, "Unauth click should open auth.html before sign-in").not.toBeNull();
      if (!authPage) return;
      await signInTestAccount(browserContext);
      signedIn = true;
      await authPage.close().catch(() => {});
      authPage = null;
      await verifyAuthedReactionHistory(browserContext, page, site);
    }
    if (options.verifyPerSiteToggle) {
      await verifyPerSiteToggleDisablesSite(browserContext, page, site);
    }

    // Pure padding by default (0): every step above already waits on its own
    // condition. The env knob stays for local debugging, where a pause between
    // scenarios makes a headed run watchable.
    const stepDelay = Number(process.env.E2E_STEP_DELAY_MS ?? 0);
    if (stepDelay > 0) await page.waitForTimeout(stepDelay);
  } finally {
    await authPage?.close().catch(() => {});
    if (signedIn) await ensureSignedOut(browserContext).catch(() => {});
    await page.close().catch(() => {});
  }
}

async function signInOnSupportedSite(browserContext: BrowserContext, page: Page, site: SupportedSiteScenario, locale = "en"): Promise<MountEvidence> {
  const evidence = await openSupportedSitePage(page, site);
  const authPage = await verifyUnauthClickOpensAuthTab(browserContext, page, site, evidence);
  expect(authPage, "Unauthenticated click should open auth.html").not.toBeNull();
  if (!authPage) return evidence;

  await signInTestAccount(browserContext, locale);
  await authPage.close().catch(() => {});
  await safeReload(page);
  await settleFullLoad(page);
  await handleKnownInterstitials(page, site);
  await settlePage(page, site);
  return waitForMountEvidence(page, site);
}

async function openSupportedSitePage(page: Page, site: SupportedSiteScenario): Promise<MountEvidence> {
  const navOk = await safeGoto(page, site.url);
  const evidence = await settleAndRequireMount(page, site, { navOk, phase: "initial" });
  expect(evidence.placementOk, debugEvidence(evidence)).toBe(true);
  expect(evidence.missingRequiredHostAncestors, debugEvidence(evidence)).toHaveLength(0);
  return evidence;
}

function localizedAdapterScenario(check: LocalizedAdapterCheck): SupportedSiteScenario {
  const site = supportedSiteScenarios.find((scenario) => scenario.site === check.site && scenario.label === check.label);
  if (!site) {
    throw new Error(`Missing localized adapter scenario: ${check.site} ${check.label}`);
  }
  return site;
}

async function verifyUnauthClickOpensAuthTab(browserContext: BrowserContext, page: Page, site: SupportedSiteScenario, evidence: MountEvidence): Promise<Page | null> {
  const loadedExtensionId = await resolveExtensionId(browserContext);
  expect(loadedExtensionId, "Emojery must be loaded before unauth click can open auth.html").not.toBeNull();
  if (!loadedExtensionId) return null;

  // Locator and keyboard only, never a click at the trigger's measured box: a
  // raw page.mouse.click hits whatever the site paints at that point, so it
  // can "click" without the trigger ever seeing the event - and it keeps
  // reporting success. The keyboard attempts are the trusted fallback.
  const attempts: Array<(trigger: ElementHandle<HTMLElement>) => Promise<void>> = [
    (trigger) => trigger.click({ timeout: 10_000 }),
    async (trigger) => {
      await trigger.focus();
      await page.keyboard.press("Enter");
    },
    async (trigger) => {
      await trigger.focus();
      await page.keyboard.press(" ");
    },
  ];

  // The trigger is re-resolved per attempt: a live feed can swap the post node
  // under it (X's virtualized timeline does exactly that while the ladder runs),
  // and a handle captured once then reports "Element is not attached to the DOM"
  // for every remaining attempt - the ladder fails without ever reaching the
  // mounted button.
  let authPage: Page | null = null;
  let sawTrigger = false;
  for (const attempt of attempts) {
    await page.bringToFront().catch(() => {});
    const trigger = await findMatchingEmojeryTrigger(page, site);
    if (!trigger) continue;
    sawTrigger = true;
    try {
      await trigger.scrollIntoViewIfNeeded({ timeout: 5_000 }).catch(() => {});
      // Three-step since the gate moved behind the pick: the trigger click opens the
      // real palette, choosing a reaction raises the gate popover, and only its
      // "Sign in & react" button opens auth.html. Playwright CSS pierces the overlay
      // root's open shadow to reach the gate button.
      authPage = await authPageFromUserAction(browserContext, loadedExtensionId, async () => {
        await attempt(trigger);
        await clickFirstUnselectedReactionOption(page);
        await page.locator(".khasky-emojery-gate-signin").click({ timeout: 10_000 });
      });
    } finally {
      await trigger.dispose().catch(() => {});
    }
    if (authPage) return authPage;
  }

  expect(sawTrigger, debugEvidence(evidence)).toBe(true);
  expect(authPage, `${site.label}: unauthenticated visible Emojery button should open auth.html`).not.toBeNull();
  return authPage;
}

async function verifyAuthedReactionHistory(browserContext: BrowserContext, page: Page, site: SupportedSiteScenario): Promise<void> {
  const navOk = await safeReload(page);
  const evidence = await settleAndRequireMount(page, site, { navOk, phase: "after-signin" });

  const picked = await pickReactionOnMatchingHost(page, site, evidence);
  const { page: historyPage, snapshot, shouldClose } = await openLatestHistoryReactionPage(browserContext, picked, site.site === "reddit" ? page : undefined);
  try {
    await historyPage.bringToFront();
    expect(snapshot.url, "History URL must be an absolute URL").toMatch(/^https?:\/\//);
    await historyPage.waitForLoadState("domcontentloaded", { timeout: 45_000 });
    await historyPage.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
    const historyEvidence = await waitForMountEvidence(historyPage, site);
    // Same tightly-guarded login-wall/anti-bot skip as the initial load (see
    // settleAndRequireMount).
    await skipWithShot(historyPage, site, isNoActionSurface(historyEvidence), `No action surface on the history URL for ${site.site} (login wall / anti-bot): ${debugEvidence(historyEvidence)}`, "no-action-surface-history-url");
    let observedReaction = await waitForReactionOnHistoryPage(historyPage, site, picked);
    if (observedReaction !== picked.reaction) {
      await historyPage.reload({ waitUntil: "domcontentloaded" });
      await historyPage.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
      observedReaction = await waitForReactionOnHistoryPage(historyPage, site, picked);
    }
    expect(observedReaction, `History URL ${snapshot.url} should show the user's reaction`).toBe(picked.reaction);
  } finally {
    if (shouldClose) await historyPage.close().catch(() => {});
  }
}

async function verifyPerSiteToggleDisablesSite(browserContext: BrowserContext, page: Page, site: SupportedSiteScenario): Promise<void> {
  let disabled = false;
  try {
    await setSiteEnabledFromPopup(browserContext, site.site, false);
    disabled = true;

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
    await handleKnownInterstitials(page, site);
    await settlePage(page, site);

    // A disabled site still stamps [data-khasky-emojery-mounted]: mount.ts claims the anchor
    // BEFORE reading settings, so "anchors present + zero hosts" is the disabled signature. If
    // that ordering ever flips, this wait times out instead of failing meaningfully.
    const disabledEvidence = await waitForDisabledSiteEvidence(page, site);
    // Same tightly-guarded login-wall/anti-bot skip as the initial load (see
    // settleAndRequireMount): without it a wall on the post-toggle reload times out and reports
    // "expected [] not to have length 0".
    await skipWithShot(page, site, isNoActionSurface(disabledEvidence), `No action surface after disabling ${site.site} in the popup (login wall / anti-bot): ${debugEvidence(disabledEvidence)}`, "no-action-surface-per-site-off");
    expect(disabledEvidence.matchingAnchorKeys, keyMatchDiagnostic(site, disabledEvidence)).not.toHaveLength(0);
    expect(disabledEvidence.matchingHostCount, debugEvidence(disabledEvidence)).toBe(0);
    expect(disabledEvidence.visibleMatchingHostCount, debugEvidence(disabledEvidence)).toBe(0);
  } finally {
    if (disabled) {
      await setSiteEnabledFromPopup(browserContext, site.site, true);
    }
  }
}

function pickerBehaviorScenario(): SupportedSiteScenario {
  const site = supportedSiteScenarios.find((scenario) => scenario.site === "github");
  if (!site) throw new Error("Missing GitHub supported-site scenario");
  return site;
}
