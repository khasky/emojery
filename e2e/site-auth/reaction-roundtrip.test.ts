// SPDX-License-Identifier: GPL-3.0-or-later
//
// Flow 1 - the core proof that an authenticated reaction round-trips: a real
// signed-in user clicks the Emojery trigger, picks an emoji, the trigger shows
// emoji+count, and the pick PERSISTS across a reload. Runs (lightly) on all 9
// sites; cross-tab sync (SW-brokered) is checked once on a stable target.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Bridge } from "./bridge";
import {
  bridgeFixture,
  closeSpawnedAuthTabs,
  gotoSettled,
  muteMedia,
  noHostMounted,
  openPickerState,
  PERMALINK_HOST_WAIT_MS,
  PERMALINK_TEST_TIMEOUT_MS,
  pickFirstEmoji,
  readEvidence,
  SETUP_HOOK_TIMEOUT_MS,
  searchInOpenPicker,
  siteAuthEnabled,
  TRIGGER_SELECTOR,
  visibleGridCount,
  waitForHost,
  zeroHostEvidence,
} from "./harness";
import { type SelectedReaction, selectedReactionProbe } from "./probes";
import { ALL_SITES, authContentUrl, type SiteId } from "./scenarios";

const fx = bridgeFixture();

// Bridge-side expression for the tab `openTab()` opened. `page` is always the tab
// under test; newPage() appends, so the opened one is the LAST page - the same rule
// bridge.close() prunes by. Never index from 0: in the connected real Chrome
// pages()[0] is one of the USER's pre-existing tabs, not ours.
const SECOND_TAB = "page.context().pages().at(-1)";

async function ensureLiveTrigger(b: Bridge, site: SiteId) {
  // Poll for the host (tolerate slow loads), then FAIL FAST (not skip): if it
  // never appears you're not logged into the site (or the test content is gone) -
  // an actionable setup fix, not something to silently pass over. Every surface
  // here is a permalink, so it gets the permalink budget (see harness).
  const visible = await waitForHost(b, site, PERMALINK_HOST_WAIT_MS);
  if (visible < 1) {
    expect(visible, noHostMounted(site, `Check the content still exists at the test URL. ${await zeroHostEvidence(b, site)}`)).toBeGreaterThan(0);
  }
  return readEvidence(b, site);
}

(siteAuthEnabled() ? describe : describe.skip)("site-auth: reaction round-trip", () => {
  beforeAll(fx.setup, SETUP_HOOK_TIMEOUT_MS);
  afterAll(fx.teardown);

  for (const site of ALL_SITES) {
    test(
      `${site}: react -> shows count -> persists after reload`,
      async () => {
        const b = fx.need();
        await gotoSettled(b, authContentUrl(site), 4000);
        await ensureLiveTrigger(b, site);

        const picker = await openPickerState(b);
        expect(picker.gridVisible, `${site}: the Emojery picker grid did not open (extension signed out?).`).toBe(true);
        await pickFirstEmoji(b);
        await b.press("Escape");
        // The counter here is still the optimistic UI.
        await b.waitFor(`const hosts = Array.from(document.querySelectorAll('.khasky-emojery-host')); return hosts.some((h) => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0 && !!(h.shadowRoot && h.shadowRoot.querySelector('button.khasky-emojery-counter')); });`, 8_000);

        const after = await readEvidence(b, site);
        const counter = after.hosts.find((h) => h.visible && h.isCounter);
        expect(counter, "trigger should become a counter after reacting").toBeTruthy();
        expect(/\d/.test(counter?.text ?? ""), "counter should show a count").toBe(true);

        // Reload: the pick must persist (server round-trip, not just optimistic UI).
        await b.reload();
        await waitForHost(b, site, PERMALINK_HOST_WAIT_MS);
        // Re-open through the SAME FB-hardened helper the pre-reload half uses, not
        // a raw first()-click: a FB permalink carries a second, off-screen host and
        // an overlapping post photo, so `.first()` + the actionability wait times
        // out (see openPickerState).
        await openPickerState(b);
        const sel = await b.evaluate<SelectedReaction>(selectedReactionProbe());
        await b.press("Escape");
        expect(sel.hasSelection, "the user's reaction should still be selected after reload").toBe(true);
        // Above the file default: this flow crosses a heavy logged-in permalink
        // TWICE (once to react, once to prove the pick survived a reload), and a
        // Facebook /posts/ page alone hydrates ~66s per pass - a measured 143s run.
      },
      PERMALINK_TEST_TIMEOUT_MS,
    );
  }

  // Typing a query into the open picker narrows the emoji grid. Run on YouTube
  // (stable single target). The durable per-locale search contract is covered by
  // the autonomous i18n test; this confirms it on real platform DOM through the bridge.
  test(
    "picker search narrows the emoji grid",
    async () => {
      const b = fx.need();
      await gotoSettled(b, authContentUrl("youtube"), 4000);
      await ensureLiveTrigger(b, "youtube");
      const picker = await openPickerState(b);
      expect(picker.gridVisible, "youtube: the Emojery picker grid did not open").toBe(true);
      const before = await visibleGridCount(b);
      await searchInOpenPicker(b, "fire");
      const after = await visibleGridCount(b);
      await b.press("Escape");
      expect(before, "the open picker should show a full emoji grid").toBeGreaterThan(1);
      expect(after, "search should narrow the grid").toBeLessThan(before);
      expect(after, "a real search term should still match at least one emoji").toBeGreaterThan(0);
    },
    PERMALINK_TEST_TIMEOUT_MS,
  );

  // Reacting must not pause or stall YouTube playback: picking an emoji leaves
  // the video playing. The harness mutes+pauses media on navigation to keep runs
  // silent, so playback is (re)started muted first.
  test(
    "youtube: reacting does not pause or stall playback",
    async () => {
      const b = fx.need();
      await gotoSettled(b, authContentUrl("youtube"), 4000);
      await ensureLiveTrigger(b, "youtube");
      await b.act(`await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.muted = true; void v.play(); } });`);
      await b.waitMs(1500);
      const before = await b.evaluate<{ paused: boolean; time: number } | null>(`const v = document.querySelector('video'); return v ? { paused: v.paused, time: v.currentTime } : null;`);
      expect(before, "youtube: no <video> element on the watch page").not.toBeNull();
      expect(before?.paused, "the video should be playing before the reaction").toBe(false);

      const picker = await openPickerState(b);
      expect(picker.gridVisible, "youtube: the Emojery picker grid did not open").toBe(true);
      await pickFirstEmoji(b);
      await b.press("Escape");
      // Long enough for a pause or a stall to show up: the failure this guards
      // against is the player reacting to our overlay, which it would do within a
      // frame or two of the pick, not seconds later.
      await b.waitMs(2000);

      const after = await b.evaluate<{ paused: boolean; time: number } | null>(`const v = document.querySelector('video'); return v ? { paused: v.paused, time: v.currentTime } : null;`);
      expect(after?.paused, "reacting must not pause the video").toBe(false);
      expect(after?.time ?? 0, "playback should keep advancing across the reaction").toBeGreaterThan(before?.time ?? 0);
      await muteMedia(b); // leave the tab silent again for the rest of the run
    },
    PERMALINK_TEST_TIMEOUT_MS,
  );

  test(
    "cross-tab: a reaction in one tab updates an already-open second tab",
    async () => {
      const b = fx.need();
      const url = authContentUrl("youtube"); // stable single-target surface
      await gotoSettled(b, url, 4000);
      // Through the same 60s wait every other flow in this file uses. Reading the
      // evidence straight off the 4s settle made this the one test that failed on a
      // watch page that merely hydrated slowly, with "no Emojery host" - the setup
      // diagnosis for what was only a late mount.
      await ensureLiveTrigger(b, "youtube");

      // Open a second tab on the same URL BEFORE reacting, so the update can only
      // arrive via the SW-brokered cross-tab push (not a fresh fetch on load).
      await b.openTab(url);
      await b.waitMs(3500);
      // Mute every tab's media so the duplicate YouTube tab doesn't blast audio.
      await b.act(`for (const p of page.context().pages()) { try { await p.evaluate(() => { for (const v of document.querySelectorAll('video, audio')) { try { v.pause(); v.muted = true; } catch {} } }); } catch {} }`);

      // The second tab opens in the BACKGROUND and YouTube gates the Emojery host behind
      // an IntersectionObserver, so its action row can stay unmounted (mount marker
      // set, no host). Reading the counter would then return '' no matter what the
      // first tab broadcasts - the "was '' now ''" failure. Scroll the anchor into
      // view in that tab and wait for the host to render, so the broadcast has a
      // real mounted counter to update.
      await b.act(
        `const t2 = ${SECOND_TAB};
       for (let i = 0; i < 10; i++) {
         await t2.evaluate(() => { const a = document.querySelector('[data-khasky-emojery-mounted]'); if (a) a.scrollIntoView({ block: 'center' }); }).catch(() => {});
         if ((await t2.locator(${JSON.stringify(TRIGGER_SELECTOR)}).count().catch(() => 0)) > 0) break;
         // Poll interval, bounded by the 10 attempts above: the second tab mounts on its
         // own IntersectionObserver, which no event in this tab can be awaited on.
         await t2.waitForTimeout(1000);
       }`,
      );
      const secondTabHostCount = await b.run<number>(`return await ${SECOND_TAB}.locator(${JSON.stringify(TRIGGER_SELECTOR)}).count().catch(() => 0);`);
      expect(secondTabHostCount, "the second tab must mount an Emojery host before reacting - else a broadcast has nothing to update (lazy IntersectionObserver mount needs the action row scrolled into view)").toBeGreaterThan(0);

      const before = await b.run<string>(
        `const t = await ${SECOND_TAB}.locator(${JSON.stringify(TRIGGER_SELECTOR)}).first();
       return (await t.textContent().catch(() => '')) || '';`,
      );
      // The two waits inside: 700ms for the popover to finish opening before a grid item is
      // clickable, then 1500ms for the vote to reach the worker and be broadcast - the second
      // tab's counter is read next, and reading it mid-flight is the flake this prevents.
      await b.act(
        `await page.bringToFront();
       await page.locator(${JSON.stringify(TRIGGER_SELECTOR)}).first().click({ timeout: 8000 });
       await page.waitForTimeout(700);
       await page.locator('.khasky-emojery-grid-item').first().click({ timeout: 8000 });
       await page.waitForTimeout(1500);`,
      );
      // This click bypasses openPickerState, so sweep any auth tab a signed-out
      // trigger click just spawned (and count it toward the abort cap).
      await closeSpawnedAuthTabs(b);
      // The second tab is only allowed to learn the new count through the SW's
      // cross-tab push, which is a full vote round-trip plus a broadcast - so this
      // wait is the push's budget, not a render settle.
      await b.waitMs(2500);
      const afterText = await b.run<string>(
        `const t = await ${SECOND_TAB}.locator(${JSON.stringify(TRIGGER_SELECTOR)}).first();
       return (await t.textContent().catch(() => '')) || '';`,
      );
      expect(afterText !== before, `second tab counter should update via broadcast (was "${before}", now "${afterText}")`).toBe(true);
    },
    PERMALINK_TEST_TIMEOUT_MS,
  );
});
