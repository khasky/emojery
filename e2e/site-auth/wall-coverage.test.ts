// SPDX-License-Identifier: GPL-3.0-or-later
//
// Per-post wall coverage: while scrolling a Facebook profile wall and a group
// wall, EVERY post whose action row has entered the viewport must carry a
// visible, correctly placed Emojery trigger. Born from the group-feed report:
// a group photo-post's action row labels its Comment/Send as
// icon-only buttons (aria «Залишити коментар» / «Надіслати», no text), which a
// text-required row-marker rule rejected - the post scrolled by with no pill
// while its neighbours had one. `scrollAndCountHosts`' maxVisible > 0 cannot
// see that class (SOME posts mounting hides the one that didn't), so this file
// audits post-by-post.
//
// A post is audited only once its Like control has been well inside the
// viewport (past the IntersectionObserver pending margin) for a settle step, so
// lazy mounting below the fold is never misread as a missing trigger. A post
// that ever reports a placed host stays good; one that never does fails the
// run with its permalink.

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Bridge } from "./bridge";
import { bridgeFixture, gotoSettled, noHostMounted, openPickerState, readEvidence, SETUP_HOOK_TIMEOUT_MS, siteAuthEnabled, triggerStillClickable, waitForHost, wheelBySrc } from "./harness";
import { postSurfaceHosts } from "./probes";
import { authFacebookGroupPostUrl, authFacebookGroupWallUrl, authFacebookProfileWallUrl } from "./scenarios";

const fx = bridgeFixture();

// ~8 x 0.7-viewport steps cover roughly 10-20 wall posts, enough to cross several
// photo/video/text post shapes without the deep-scroll budget.
const WALL_STEPS = Number(process.env.E2E_WALL_SCROLL_STEPS ?? 8);
const WALL_TIMEOUT_MS = 360_000;

// The trigger mounts beside the post's Like control, so "correctly placed"
// is: host vertically level with the Like (one action row). Generous bound -
// wrapped rows on narrow layouts still pass; a host parked at the post's top
// or dropped after the comments does not.
const PLACE_TOLERANCE_PX = 60;

interface WallPost {
  id: string;
  likeTop: number;
  hasHost: boolean;
  hostTop: number | null;
  placed: boolean;
}

// In-page audit of every TOP-LEVEL post article whose Like control is well
// inside the viewport (past the IO pending margin: likeTop < vh - 250, and not
// scrolled out: likeTop > -150). Nested articles are comments and never count;
// units without a post Like (people-you-may-know, join prompts) are skipped.
// The id prefers the post's own permalink (stable across steps), falling back
// to aria-posinset.
const WALL_AUDIT_SRC = `
const LIKE = /(?:\\bun)?like(?:d)?\\b|нрав|подоба|вподоб/iu;
const REMOVE = /^(remove|убрать|удалить|видалити|скасувати)/i;
const MENU = /\\breaction\\b|реакц/iu;
const posts = [];
const topArticles = [...document.querySelectorAll('[role="article"]')]
  .filter((a) => !(a.parentElement && a.parentElement.closest('[role="article"]')));
for (const art of topArticles) {
  if (art.getBoundingClientRect().width === 0) continue;
  const like = [...art.querySelectorAll('[role="button"][aria-label]')].find((b) => {
    const aria = b.getAttribute('aria-label') || '';
    if (MENU.test(aria)) return false;
    if (!(LIKE.test(aria) || REMOVE.test(aria))) return false;
    if (b.closest('[role="article"]') !== art) return false;
    return b.getBoundingClientRect().width > 0;
  });
  if (!like) continue;
  const likeTop = Math.round(like.getBoundingClientRect().top);
  if (likeTop <= -150 || likeTop >= innerHeight - 250) continue;
  const host = [...art.querySelectorAll('.khasky-emojery-host')]
    .find((h) => h.getBoundingClientRect().width > 0);
  const hostTop = host ? Math.round(host.getBoundingClientRect().top) : null;
  const link = [...art.querySelectorAll('a[href]')]
    .map((a) => a.getAttribute('href') || '')
    .find((h) => /\\/posts\\/|\\/photo|pfbid|permalink|\\/videos\\/|\\/reel\\//.test(h));
  posts.push({
    id: link ? link.split('?')[0].slice(-80) : 'posinset:' + (art.getAttribute('aria-posinset') || 'top' + likeTop),
    likeTop,
    hasHost: !!host,
    hostTop,
    placed: !!host && Math.abs(hostTop - likeTop) <= ${PLACE_TOLERANCE_PX},
  });
}
return posts;`;

// Scroll the wall in steps and track each audited post's BEST observed state:
// a post that ever reports a placed host is good for the run; one that never
// does is a real miss. A bad step re-reads once after a settle first, so a
// mount racing the audit (the IO callback fires between wheel and read) never
// records a false miss.
async function auditWall(b: Bridge, url: string, keyName: string): Promise<void> {
  await gotoSettled(b, url, 4500);
  expect(await waitForHost(b, "facebook", 15_000), noHostMounted("facebook", `The account also has to be able to read the ${keyName} surface.`)).toBeGreaterThan(0);

  const best = new Map<string, WallPost>();
  for (let step = 0; step < WALL_STEPS; step++) {
    let posts = await b.evaluate<WallPost[]>(WALL_AUDIT_SRC);
    if (posts.some((p) => !p.placed)) {
      await b.waitMs(1800);
      posts = await b.evaluate<WallPost[]>(WALL_AUDIT_SRC);
    }
    for (const p of posts) {
      const prev = best.get(p.id);
      if (!prev || (p.placed && !prev.placed)) best.set(p.id, p);
    }
    // 1000ms per screen: the walk samples what is mounted after each scroll, and a feed
    // that has not finished hydrating reports posts as unplaced that simply are not there yet.
    await b.act(`${wheelBySrc("Math.round((page.viewportSize()?.height || 800) * 0.7)")} await page.waitForTimeout(1000);`);
  }

  expect(best.size, `${keyName}: the scroll audited no posts at all - the account cannot read this surface (fix ${keyName} in .env.e2e / .env.e2e.local) or Facebook changed its post markup.`).toBeGreaterThan(0);
  const missing = [...best.values()].filter((p) => !p.hasHost);
  expect(missing, `every scrolled post must carry an Emojery trigger - these never mounted one: ${JSON.stringify(missing)}`).toHaveLength(0);
  const misplaced = [...best.values()].filter((p) => p.hasHost && !p.placed);
  expect(misplaced, `every trigger must sit level with its post's Like control (+/-${PLACE_TOLERANCE_PX}px) - misplaced: ${JSON.stringify(misplaced)}`).toHaveLength(0);
  expect(await triggerStillClickable(b), "a wall trigger must open on click after the scroll").toBe(true);
}

(siteAuthEnabled() ? describe : describe.skip)("site-auth: per-post wall coverage", () => {
  beforeAll(fx.setup, SETUP_HOOK_TIMEOUT_MS);
  afterAll(fx.teardown);

  test(
    "facebook: profile wall - every scrolled post gets a placed, clickable trigger",
    async () => {
      await auditWall(fx.need(), authFacebookProfileWallUrl(), "E2E_AUTHURL_FACEBOOK_WALL");
    },
    WALL_TIMEOUT_MS,
  );

  test(
    "facebook: group wall - every scrolled post gets a placed, clickable trigger",
    async () => {
      await auditWall(fx.need(), authFacebookGroupWallUrl(), "E2E_AUTHURL_FACEBOOK_GROUP_WALL");
    },
    WALL_TIMEOUT_MS,
  );

  // The reported group permalinks themselves: exactly one picker on the post's
  // surface (the dialog when FB opens one, else the page), and a click opens
  // the emoji grid (assertEmojerySignedIn guarantees the signed-in state).
  test("facebook: group post permalink mounts one clickable picker", async () => {
    const b = fx.need();
    await gotoSettled(b, authFacebookGroupPostUrl(), 4500);
    expect(await waitForHost(b, "facebook", 15_000), "facebook: no Emojery host on the group post permalink (E2E_AUTHURL_FACEBOOK_GROUP_DETAIL) - the group photo-row regression's exact surface.").toBeGreaterThan(0);
    const ev = await readEvidence(b, "facebook");
    expect(postSurfaceHosts(ev).length, "a group post permalink must keep exactly one visible picker on the post's surface").toBe(1);
    expect(ev.duplicateKeys).toHaveLength(0);
    const picker = await openPickerState(b);
    await b.press("Escape").catch(() => {});
    expect(picker.gridVisible, "clicking the group post's trigger must open the emoji grid").toBe(true);
  }, 120_000);
});
