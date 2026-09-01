// SPDX-License-Identifier: GPL-3.0-or-later
//
// Driving the extension's OWN surfaces from a live-site suite: the popup's
// History tab, the settings the scenarios toggle, and the auth tab an unauth
// click opens.
//
// The recurring hazard the history helpers here work around: a vote reaches history
// TWICE - optimistically inside `enqueueVote`, then again once `flushVotes` has the
// server's answer (background/api.ts) - and the History view loads once, with no
// live-refresh, so a read taken right after the click can catch the optimistic row
// or nothing at all. The helpers that assert on a SETTLED row therefore poll
// `history:page` through the popup's own runtime channel first and open the tab only
// after it reports what they expect.
import { type BrowserContext, expect, type Page } from "@playwright/test";
import type { SiteId } from "../supported-sites";
import { enMessage, extensionPageUrl } from "./auth-signin";
import { openPopup, signIn } from "./extension-pages";
import { handleKnownInterstitials } from "./page-settle";
import { openVisiblePickerAndReadSelectedReaction, pollForValue, selectedReactionOnMatchingHost, waitForMountedTargetKey, waitForVisibleEmojeryTrigger } from "./picker-probes";
import { setPopupCheckbox } from "./popup-settings";
import type { PickedReaction, SupportedSiteScenario } from "./site-evidence";
import { siteLabel } from "./site-evidence";
import { dismissLoginWalls } from "./site-walls";
import { authEmail, authOtp } from "./test-config";

// How long a queued vote may take to reach local history. Covers a cold service
// worker doing IndexedDB work on a feed-heavy page, not a healthy flush.
const HISTORY_FLUSH_TIMEOUT_MS = 30_000;

interface HistorySnapshot {
  reaction: string;
  targetKey: string;
  url: string;
}

interface OpenedHistoryReactionPage {
  page: Page;
  snapshot: HistorySnapshot;
  /** False when the caller supplied the page to navigate, so it owns closing it. */
  shouldClose: boolean;
}

export async function authPageFromUserAction(browserContext: BrowserContext, loadedExtensionId: string, action: () => Promise<void>): Promise<Page | null> {
  const expectedUrl = extensionPageUrl(loadedExtensionId, "auth.html");
  const pagePromise = browserContext.waitForEvent("page", { timeout: 5_000 }).catch(() => null);

  await action().catch(() => {});
  const openedPage = await pagePromise;
  const candidates = [...(openedPage ? [openedPage] : []), ...browserContext.pages().filter((candidate) => candidate !== openedPage)];

  for (const candidate of candidates) {
    if (!candidate.url().startsWith(expectedUrl)) {
      await candidate.waitForURL(expectedUrl, { timeout: 750 }).catch(() => {});
    }
    if (!candidate.url().startsWith(expectedUrl)) continue;
    await expect(candidate.locator("#email-input")).toBeVisible();
    return candidate;
  }

  return null;
}

// The caller closes the auth tab the unauth click opened; signIn works in a tab of its own.
export async function signInTestAccount(browserContext: BrowserContext, locale = "en"): Promise<void> {
  await signIn(browserContext, authEmail(), authOtp(), locale);
}

export async function setReplaceNativeFromPopup(browserContext: BrowserContext, desired: boolean): Promise<void> {
  await setPopupCheckbox(browserContext, { tab: "Settings", name: "Hide original buttons", checked: desired });
  // Let the settings watcher reach the already-open site tab before the caller
  // asserts on it.
  await new Promise((settle) => setTimeout(settle, 500));
}

// Through setPopupCheckbox, which SELECTS the Settings tab first: the popup
// reopens on the tab it was last left on, and every authed flow here has just
// been on History - opening popup.html and reaching for a settings control
// straight away finds the History view instead.
export async function setSiteEnabledFromPopup(browserContext: BrowserContext, site: SiteId, enabled: boolean): Promise<void> {
  await setPopupCheckbox(browserContext, { tab: "Settings", name: enMessage("perSiteToggleAria", siteLabel(site)), checked: enabled });
}

export async function waitForReactionOnHistoryPage(page: Page, site: SupportedSiteScenario, picked: PickedReaction): Promise<string | null> {
  await handleKnownInterstitials(page, site);
  await dismissLoginWalls(page);
  await waitForMountedTargetKey(page, picked.targetKey, site);

  // Wait stage only: the caller asserts the final observed reaction, so a slow
  // hydrate falls through to the picker read below instead of dying here.
  const visibleReaction = await pollForValue(
    () => selectedReactionOnMatchingHost(page, picked.targetKey),
    (reaction) => reaction === picked.reaction,
    Number(process.env.E2E_HISTORY_REACTION_TIMEOUT_MS ?? 20_000),
  );
  if (visibleReaction === picked.reaction) return visibleReaction;

  const trigger = await waitForVisibleEmojeryTrigger(page, site, picked.targetKey);
  expect(trigger, `${site.label}: History URL should show a visible Emojery button`).not.toBeNull();
  if (!trigger) return null;

  return openVisiblePickerAndReadSelectedReaction(page, trigger, picked.reaction);
}

// Open the popup on its History tab - the caller owns closing the returned page.
// `waitForRows` also waits for the first rendered row; callers reading a
// possibly-empty list skip it and judge the empty state themselves.
export async function openHistoryTab(browserContext: BrowserContext, opts: { viewport?: { width: number; height: number }; waitForRows?: boolean } = {}): Promise<Page> {
  const popup = await openPopup(browserContext);
  if (opts.viewport) await popup.setViewportSize(opts.viewport);
  await popup.getByRole("tab", { name: enMessage("tabHistory") }).click();
  if (opts.waitForRows) await expect(popup.locator(".history li").first()).toBeVisible();
  return popup;
}

export async function expectHistorySignedOut(browserContext: BrowserContext): Promise<void> {
  const popup = await openPopup(browserContext);
  try {
    await popup.getByRole("tab", { name: enMessage("tabHistory") }).click();
    await expect(
      popup.getByText(enMessage("signInMsgHistory"), {
        exact: true,
      }),
    ).toBeVisible();
    await expect(popup.getByRole("button", { name: enMessage("signInBtn") })).toBeVisible();
    await expect(popup.locator(".history li")).toHaveCount(0);
  } finally {
    await popup.close().catch(() => {});
  }
}

// How many rows a freshly signed-in account's local history holds - the check
// that no foreign account's reactions came with the sign-in. Not "empty": the
// sign-in gate casts the reaction it was holding, so the first row is that pick.
// The count is polled through the runtime channel BEFORE the tab is opened, since
// the History view loads once and would snapshot a pre-flush list (module header).
export async function expectHistoryRowCount(browserContext: BrowserContext, expected: number): Promise<void> {
  const popup = await openPopup(browserContext);
  try {
    await expect
      .poll(() => popup.evaluate(() => chrome.runtime.sendMessage({ type: "history:page", limit: 50 }).then((resp: { items?: unknown[] } | undefined) => resp?.items?.length ?? 0)), {
        message: `local history should settle at ${expected} row(s) for this account`,
        timeout: HISTORY_FLUSH_TIMEOUT_MS,
      })
      .toBe(expected);

    await popup.getByRole("tab", { name: enMessage("tabHistory") }).click();
    await expect(popup.locator(".history li")).toHaveCount(expected);
  } finally {
    await popup.close().catch(() => {});
  }
}

export async function expectLatestHistoryReactions(browserContext: BrowserContext, expectedReactions: string[]): Promise<void> {
  const popup = await openPopup(browserContext);
  try {
    // Reading immediately races the flush (see the module header) and finds the
    // previous reaction still on top. Wait for the expected reactions to reach
    // local history - in the exact leading order asserted - BEFORE opening the tab.
    await expect
      .poll(
        () =>
          popup.evaluate(
            (expected) =>
              chrome.runtime.sendMessage({ type: "history:page", limit: 50 }).then((resp: { items?: Array<{ reaction?: string }> } | undefined) => {
                const hist = resp?.items ?? [];
                return expected.every((reaction, index) => hist[index]?.reaction === reaction);
              }),
            expectedReactions,
          ),
        {
          message: "the picked reactions should reach local history in order after the vote flush",
          timeout: HISTORY_FLUSH_TIMEOUT_MS,
        },
      )
      .toBe(true);

    await popup.getByRole("tab", { name: enMessage("tabHistory") }).click();
    const rows = popup.locator(".history li");
    await expect
      .poll(() => rows.count(), {
        message: "History should show enough visible reaction rows",
      })
      .toBeGreaterThanOrEqual(expectedReactions.length);

    for (let index = 0; index < expectedReactions.length; index += 1) {
      const row = rows.nth(index);
      await expect(row.locator(".history-emoji")).toHaveText(expectedReactions[index]!);
      const link = row.locator("a.history-link").first();
      await expect(link).toBeVisible();
      const url = await link.getAttribute("href");
      expect(url, "History row should expose an absolute target URL").toMatch(/^https?:\/\//);
    }
  } finally {
    await popup.close().catch(() => {});
  }
}

export async function expectHistorySearchFiltersReaction(browserContext: BrowserContext, reaction: string): Promise<void> {
  const popup = await openPopup(browserContext);
  try {
    await popup.getByRole("tab", { name: enMessage("tabHistory") }).click();
    const search = popup.locator(".history-search-input");
    const rows = popup.locator(".history li");
    await expect(search).toBeVisible();

    await search.fill(reaction);
    // The query is debounced (HISTORY_SEARCH_DEBOUNCE_MS) and answered by a
    // background IndexedDB scan, so the UNFILTERED rows stay in the DOM for a
    // beat after fill - counting rows here would snapshot the pre-filter list.
    // Wait until no visible row shows another reaction (only true once the
    // filtered result rendered), then require a non-empty match.
    const rowEmojis = popup.locator(".history li .history-emoji");
    await expect(rowEmojis.filter({ hasNotText: reaction })).toHaveCount(0);
    await expect
      .poll(() => rows.count(), {
        message: "History search should show matching reaction rows",
      })
      .toBeGreaterThan(0);

    await search.fill(`no-history-match-${Date.now()}`);
    await expect(rows).toHaveCount(0);
    await expect(popup.locator(".history-nomatch")).toBeVisible();

    await search.fill("");
    await expect
      .poll(() => rows.count(), {
        message: "Clearing History search should restore rows",
      })
      .toBeGreaterThan(0);
  } finally {
    await popup.close().catch(() => {});
  }
}

export async function openLatestHistoryReactionPage(browserContext: BrowserContext, picked: PickedReaction, openInPage?: Page): Promise<OpenedHistoryReactionPage> {
  const popup = await openPopup(browserContext);
  try {
    // On feed-heavy sites the busy service worker can flush AFTER the popup
    // opens, so an immediate read finds nothing (it passes on a single-target
    // page like GitHub, where the flush finishes first). See the module header.
    await expect
      .poll(
        () =>
          popup.evaluate(
            (expected) =>
              chrome.runtime.sendMessage({ type: "history:page", limit: 50 }).then((resp: { items?: Array<{ reaction?: string }> } | undefined) => {
                const hist = resp?.items ?? [];
                return hist.some((entry) => entry.reaction === expected) ? hist.length : 0;
              }),
            picked.reaction,
          ),
        {
          message: "the picked reaction should reach local history after the vote flush",
          timeout: HISTORY_FLUSH_TIMEOUT_MS,
        },
      )
      .toBeGreaterThan(0);
    await popup.getByRole("tab", { name: enMessage("tabHistory") }).click();
    const first = popup.locator(".history li").first();
    await expect(first).toBeVisible();
    await expect(first.locator(".history-emoji")).toHaveText(picked.reaction);
    const link = first.locator("a.history-link").first();
    await expect(link).toBeVisible();
    const href = await link.getAttribute("href");
    expect(href, "History row should expose an absolute target URL").toMatch(/^https?:\/\//);

    const historyPage = openInPage ?? (await browserContext.newPage());
    await historyPage.bringToFront();
    await historyPage.goto(href!, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await historyPage.waitForLoadState("domcontentloaded", {
      timeout: 45_000,
    });
    await historyPage.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
    return {
      page: historyPage,
      snapshot: { reaction: picked.reaction, targetKey: picked.targetKey, url: href! },
      shouldClose: !openInPage,
    };
  } finally {
    await popup.close().catch(() => {});
  }
}
