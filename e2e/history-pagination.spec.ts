// SPDX-License-Identifier: GPL-3.0-or-later
//
// Popup History tab paging, search and facet filtering over the uncapped IndexedDB
// store. The view fetches 100-row pages from the background on demand ("Show more"
// is a real fetch, not a slice), and search runs in the background as an IndexedDB
// scan - so a 10,000-row account must page and filter without the popup ever
// holding the whole store. The second test covers the facet bar, whose counts have
// to come off the same filter as the rows: the popup, the message guard and the
// store were each self-consistent while the bar still tallied the whole history.
//
// A real account cannot click out thousands of votes in a test, so rows are
// seeded straight into the background's IndexedDB from the service worker
// (mirroring the schema in src/background/history.ts) under the signed-in account's
// own userId. Each stage is asserted AND captured as a screenshot into the
// test's test-results dir (also attached to the HTML report).
import { type BrowserContext, expect, type Page, type TestInfo, test } from "@playwright/test";
import * as ext from "./lib/extension";
import { openHistoryTab } from "./lib/popup-probes";
import { HISTORY_LINK_SELECTOR, HISTORY_MORE_SELECTOR, HISTORY_NOMATCH_SELECTOR, HISTORY_ROW_SELECTOR, HISTORY_SEARCH_INPUT_SELECTOR } from "./lib/selectors";

const REQUIRES_OTP = ext.otpSkipReason("the History paging checks");

// Mirrors HISTORY_PAGE in src/entrypoints/popup/popup-history.tsx.
const PAGE_SIZE = 100;
// Large enough to prove the uncapped store pages fine, small enough to seed fast.
const VOLUME = 10_000;

// The row the unique-match search must find, derived from VOLUME rather than hardcoded -
// it was coupled to it in BOTH directions. Mid-store, so the match proves the background
// scans the whole STORE and not just the pages already loaded; and as many digits as the
// highest seeded index, because a shorter needle is a prefix of ten longer rows ("repo-4242"
// also matches repo-42420..42429 once the store holds 100k).
const UNIQUE_ROW_NAME = `repo-${Math.floor((VOLUME - 1) / 2)}`;
const UNIQUE_ROW_URL = `https://github.com/e2e-seed/${UNIQUE_ROW_NAME}`;

// Popup-like window so the screenshots read as the real popup, not a wide tab.
const POPUP_VIEWPORT = { width: 400, height: 640 };

// Replace the device-local history with `count` seeded rows for the CURRENT
// account, oldest inserted first so `repo-<count-1>` is the newest row on top.
// The schema literals mirror src/background/history.ts - a mismatch fails the
// test loudly.
async function seedHistoryRows(context: BrowserContext, count: number): Promise<void> {
  await ext.evalInBackground(
    context,
    async ({ count }: { count: number }) => {
      const api = (globalThis as { browser?: typeof browser }).browser ?? (chrome as unknown as typeof browser);
      const { indexedDB } = globalThis as unknown as { indexedDB: IDBFactory };
      const stored = (await api.storage.local.get("auth_v1")) as Record<string, { userId?: string } | undefined>;
      const userId = stored.auth_v1?.userId;
      if (!userId) throw new Error("history seeding needs a signed-in session");
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const req = indexedDB.open("emojery-history", 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains("history")) {
            const store = d.createObjectStore("history", { keyPath: "id", autoIncrement: true });
            store.createIndex("byUserAndId", ["userId", "id"]);
            store.createIndex("byHistoryId", "historyId");
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const reactions = ["❤️", "\u{1F525}", "\u{1F44D}", "\u{1F602}", "\u{1F389}"];
      const actions = ["add", "change", "remove"];
      const newestTs = Date.now();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("history", "readwrite");
        const store = tx.objectStore("history");
        store.clear();
        for (let i = 0; i < count; i++) {
          store.add({
            historyId: `e2e-page-${i}`,
            userId,
            target: { site: "github", targetId: `e2e-seed-${i}`, url: `https://github.com/e2e-seed/repo-${i}` },
            reaction: reactions[i % reactions.length],
            ts: newestTs - (count - 1 - i) * 60_000,
            action: actions[i % actions.length],
          });
        }
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    { count },
  );
}

const openSizedHistoryTab = (context: BrowserContext) => openHistoryTab(context, { viewport: POPUP_VIEWPORT, waitForRows: true });

async function captureStage(popup: Page, testInfo: TestInfo, stage: string): Promise<void> {
  // Scrolling can land a row under the idle pointer and pop its URL tooltip -
  // park the mouse in the header first so the shot shows only the list state.
  await popup.mouse.move(0, 0);
  const path = testInfo.outputPath(`${stage}.png`);
  await popup.screenshot({ path });
  await testInfo.attach(stage, { path, contentType: "image/png" });
}

test("History paging and search stay correct over a 10k-row uncapped store", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  test.skip(ext.isFirefoxRun(), "pages and screenshots the popup's History view through Playwright, which cannot attach to it on Firefox (the seeding itself goes through the bridge)");
  // test.info() instead of the `({}, testInfo)` callback parameters: the empty
  // fixture destructuring trips biome's noEmptyPattern.
  const testInfo = test.info();
  const showMoreLabel = ext.localeMessage("en", "pickerShowMore");
  const session = await ext.launchSession();
  try {
    await ext.signIn(session.context);

    await seedHistoryRows(session.context, VOLUME);
    let popup = await openSizedHistoryTab(session.context);
    let rows = popup.locator(HISTORY_ROW_SELECTOR);
    let moreBtn = popup.locator(`${HISTORY_MORE_SELECTOR} button`);
    await expect(rows).toHaveCount(PAGE_SIZE);
    await expect(rows.first().locator(HISTORY_LINK_SELECTOR)).toHaveAttribute("href", `https://github.com/e2e-seed/repo-${VOLUME - 1}`);
    await expect(moreBtn).toHaveText(showMoreLabel);
    await moreBtn.scrollIntoViewIfNeeded();
    await captureStage(popup, testInfo, "history-1-10k-first-page");

    await moreBtn.click();
    await expect(rows).toHaveCount(2 * PAGE_SIZE);
    await expect(rows.last().locator(HISTORY_LINK_SELECTOR)).toHaveAttribute("href", `https://github.com/e2e-seed/repo-${VOLUME - 2 * PAGE_SIZE}`);
    await expect(moreBtn).toBeVisible();
    await moreBtn.scrollIntoViewIfNeeded();
    await captureStage(popup, testInfo, "history-2-10k-after-show-more");

    const searchBox = popup.locator(HISTORY_SEARCH_INPUT_SELECTOR);
    await searchBox.fill(UNIQUE_ROW_NAME);
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(HISTORY_LINK_SELECTOR)).toHaveAttribute("href", UNIQUE_ROW_URL);
    await expect(popup.locator(HISTORY_MORE_SELECTOR)).toHaveCount(0);
    await captureStage(popup, testInfo, "history-3-10k-search-unique-match");

    await searchBox.fill("e2e-seed");
    await expect(rows).toHaveCount(PAGE_SIZE);
    await expect(moreBtn).toBeVisible();
    await moreBtn.click();
    await expect(rows).toHaveCount(2 * PAGE_SIZE);
    await moreBtn.scrollIntoViewIfNeeded();
    await captureStage(popup, testInfo, "history-4-10k-search-paged");

    await searchBox.fill("no-such-history-row");
    await expect(popup.locator(HISTORY_NOMATCH_SELECTOR)).toBeVisible();
    await expect(rows).toHaveCount(0);
    await popup.close().catch(() => {});

    await seedHistoryRows(session.context, PAGE_SIZE);
    popup = await openSizedHistoryTab(session.context);
    rows = popup.locator(HISTORY_ROW_SELECTOR);
    await expect(rows).toHaveCount(PAGE_SIZE);
    await expect(popup.locator(HISTORY_MORE_SELECTOR)).toHaveCount(0);
    await rows.last().scrollIntoViewIfNeeded();
    await captureStage(popup, testInfo, "history-5-exactly-100-no-pager");
    await popup.close().catch(() => {});

    await seedHistoryRows(session.context, PAGE_SIZE + 1);
    popup = await openSizedHistoryTab(session.context);
    rows = popup.locator(HISTORY_ROW_SELECTOR);
    moreBtn = popup.locator(`${HISTORY_MORE_SELECTOR} button`);
    await expect(rows).toHaveCount(PAGE_SIZE);
    await expect(moreBtn).toHaveText(showMoreLabel);
    await moreBtn.scrollIntoViewIfNeeded();
    await captureStage(popup, testInfo, "history-6-101-rows-pager-offered");

    await moreBtn.click();
    await expect(rows).toHaveCount(PAGE_SIZE + 1);
    await expect(popup.locator(HISTORY_MORE_SELECTOR)).toHaveCount(0);
    await rows.last().scrollIntoViewIfNeeded();
    await captureStage(popup, testInfo, "history-7-101-rows-fully-expanded");
    await popup.close().catch(() => {});
  } finally {
    await ext.closeSession(session);
  }
});

// Rows shaped for the facet walk, replacing whatever the account holds: three github
// reactions from today and one reddit reaction from three days ago, so the site and the
// date controls each hold back a different row. Schema literals mirror seedHistoryRows.
async function seedFacetRows(context: BrowserContext): Promise<void> {
  await ext.evalInBackground(context, async () => {
    const api = (globalThis as { browser?: typeof browser }).browser ?? (chrome as unknown as typeof browser);
    const { indexedDB } = globalThis as unknown as { indexedDB: IDBFactory };
    const stored = (await api.storage.local.get("auth_v1")) as Record<string, { userId?: string } | undefined>;
    const userId = stored.auth_v1?.userId;
    if (!userId) throw new Error("history seeding needs a signed-in session");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open("emojery-history", 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains("history")) {
          const store = d.createObjectStore("history", { keyPath: "id", autoIncrement: true });
          store.createIndex("byUserAndId", ["userId", "id"]);
          store.createIndex("byHistoryId", "historyId");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const now = Date.now();
    const rows = [
      { site: "github", targetId: "e2e-facet-1", url: "https://github.com/e2e-facet/one", reaction: "\u{1F44D}", ts: now - 60_000 },
      { site: "github", targetId: "e2e-facet-2", url: "https://github.com/e2e-facet/two", reaction: "\u{1F44D}", ts: now - 120_000 },
      { site: "github", targetId: "e2e-facet-3", url: "https://github.com/e2e-facet/three", reaction: "\u{1F525}", ts: now - 180_000 },
      { site: "reddit", targetId: "e2e-facet-4", url: "https://www.reddit.com/e2e-facet/four", reaction: "\u{1F438}", ts: now - 3 * 86_400_000 },
    ];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("history", "readwrite");
      const store = tx.objectStore("history");
      store.clear();
      for (const [i, row] of rows.entries()) {
        store.add({ historyId: `e2e-facet-${i}`, userId, target: { site: row.site, targetId: row.targetId, url: row.url }, reaction: row.reaction, ts: row.ts, action: "add" });
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
}

test("History facet counts answer for the filters stacked around them", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  test.skip(ext.isFirefoxRun(), "drives the popup's History view through Playwright, which cannot attach to it on Firefox (the seeding itself goes through the bridge)");
  const testInfo = test.info();
  const session = await ext.launchSession();
  try {
    await ext.signIn(session.context);
    await seedFacetRows(session.context);

    const popup = await openSizedHistoryTab(session.context);
    const chips = popup.locator(".facet-chip");
    const rows = popup.locator(HISTORY_ROW_SELECTOR);
    const siteSelect = popup.getByLabel(ext.localeMessage("en", "facetSiteAria"));
    const rangeSelect = popup.getByLabel(ext.localeMessage("en", "facetRangeAria"));

    // Unfiltered: every emoji the account holds, the most-used first.
    await expect(chips).toHaveCount(3);
    await expect(chips.first().locator(".facet-chip-count")).toHaveText("2");
    await expect(rows).toHaveCount(4);

    // Reddit holds one reaction, so the strip narrows to that one. Tallied over the whole
    // history instead, it would still be offering the three github reactions have.
    await siteSelect.selectOption("reddit");
    await expect(chips).toHaveCount(1);
    await expect(chips.first().locator(".facet-chip-count")).toHaveText("1");
    await expect(rows).toHaveCount(1);
    await captureStage(popup, testInfo, "facets-1-narrowed-to-one-site");

    // The count a chip shows is the list the click lands on - never an empty one.
    await chips.first().click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(HISTORY_LINK_SELECTOR)).toHaveAttribute("href", "https://www.reddit.com/e2e-facet/four");

    // Today holds no reddit reaction, so this combination is necessarily empty. Both
    // selections must survive it, or nothing is left to undo them with.
    await rangeSelect.selectOption("today");
    await expect(popup.locator(HISTORY_NOMATCH_SELECTOR)).toBeVisible();
    await expect(chips).toHaveCount(1);
    await expect(chips.first().locator(".facet-chip-count")).toHaveText("0");
    await expect(chips.first()).toHaveAttribute("aria-pressed", "true");
    await expect(siteSelect).toHaveValue("reddit");
    await captureStage(popup, testInfo, "facets-2-emptied-but-still-clearable");

    await rangeSelect.selectOption("all");
    await expect(rows).toHaveCount(1);
    await expect(chips.first().locator(".facet-chip-count")).toHaveText("1");
    await popup.close().catch(() => {});
  } finally {
    await ext.closeSession(session);
  }
});
