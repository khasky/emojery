// SPDX-License-Identifier: GPL-3.0-or-later
//
// Flow 2 - feed / lifecycle stability on the bot-sensitive, feed-heavy sites.
// These are the invariants the recent logged-in bug classes violated; they are
// chosen to be robustly checkable black-box (no fragile per-post targeting).
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bridgeFixture, gotoSettled, noHostMounted, PERMALINK_HOST_WAIT_MS, PERMALINK_TEST_TIMEOUT_MS, readEvidence, SETUP_HOOK_TIMEOUT_MS, scrollAndCountHosts, siteAuthEnabled, triggerStillClickable, usedHeapMb, waitForHost, wheelBySrc } from "./harness";
import { DQ_SRC, postSurfaceHosts } from "./probes";
import { ALL_SITES, authContentUrl, authFacebookGroupUrl, authFeedUrl, authInstagramCarouselUrl, authThreadsRepliesUrl, DEEP_SITES } from "./scenarios";
import { applyWarmups, LIFECYCLE_WARMUPS, type Undo } from "./warmup";

const fx = bridgeFixture();

// See warmup.ts.
let restoreWarmups: Undo = async () => {};

// Heavy-feed depth: ~20 x 0.7-viewport steps traverses roughly 50-100 feed
// posts. Overridable for a quicker/longer sweep.
const DEEP_STEPS = Number(process.env.E2E_DEEP_SCROLL_STEPS ?? 20);

// Measured on the live Facebook feed: one step (dismiss-dialogs read, evidence
// read, wheel, settle) costs ~7s on a fresh feed and ~14s deep into it, where the
// accumulated DOM slows every bridge call - so 20 steps run to ~300s, well past
// the suite-wide 180s default. Budget the slowest site with headroom; the other
// deep sites finish in ~2min and are unaffected. Scale E2E_DEEP_SCROLL_STEPS
// down for a quicker sweep.
const DEEP_SCROLL_TIMEOUT_MS = 420_000;

(siteAuthEnabled() ? describe : describe.skip)("site-auth: lifecycle stability", () => {
  beforeAll(fx.setup, SETUP_HOOK_TIMEOUT_MS);
  beforeAll(async () => {
    if (!siteAuthEnabled()) return;
    restoreWarmups = await applyWarmups(fx.need(), LIFECYCLE_WARMUPS);
  }, 180_000);
  // Restore FIRST (still needs the live bridge), then drop the connection.
  afterAll(async () => {
    await restoreWarmups().catch(() => {});
    await fx.teardown();
  });

  // Cross-cutting invariant on ALL 9 sites: a logged-in surface mounts at least
  // one host and never leaves two connected hosts on one target key (the
  // duplicate/stolen-host bug). The single-target sites (YouTube/GitHub/GitLab/
  // Amazon) carry one target, so the no-duplicate half is the whole check there.
  for (const site of ALL_SITES) {
    test(`${site}: mounts hosts with no duplicate target keys`, async () => {
      const b = fx.need();
      await gotoSettled(b, authFeedUrl(site), 4000);
      const { maxVisible, sawDuplicate } = await scrollAndCountHosts(b, site, 6);
      // FAIL FAST (not skip): no host = you're not logged into the site.
      expect(maxVisible, noHostMounted(site)).toBeGreaterThan(0);
      expect(sawDuplicate, "one target key must not have multiple connected hosts").toBe(false);
    });
  }

  // Heavy feed: a long scroll over the feed-heavy sites must stay stable -
  // no duplicate keys accumulate and a trigger stays clickable at the end. Memory
  // is logged as a best-effort heuristic (not asserted).
  for (const site of DEEP_SITES) {
    test(
      `${site}: heavy feed stays stable across a deep scroll`,
      async () => {
        const b = fx.need();
        await gotoSettled(b, authFeedUrl(site), 4500);
        expect(await waitForHost(b, site, 12_000), noHostMounted(site)).toBeGreaterThan(0);
        const heapBefore = await usedHeapMb(b);
        const { maxVisible, sawDuplicate } = await scrollAndCountHosts(b, site, DEEP_STEPS);
        expect(maxVisible, "hosts should keep mounting through a long feed").toBeGreaterThan(0);
        expect(sawDuplicate, "a long scroll must not leave duplicate target keys").toBe(false);
        expect(await triggerStillClickable(b), "a reaction trigger must stay clickable after a deep scroll").toBe(true);
        const heapAfter = await usedHeapMb(b);
        console.log(`[deep-scroll] ${site}: heap ${heapBefore ?? "?"}->${heapAfter ?? "?"} MB over ${DEEP_STEPS} steps, maxVisibleHosts=${maxVisible}`);
        // Coarse leak backstop, not a perf benchmark: the page's OWN heap swings by
        // hundreds of MB over a deep feed scroll, so only a blowout beyond this
        // generous budget is meaningful. Tune per machine via
        // E2E_DEEP_SCROLL_HEAP_LIMIT_MB; 0 disables the assertion (log-only).
        const heapLimitMb = Number(process.env.E2E_DEEP_SCROLL_HEAP_LIMIT_MB ?? 600);
        if (heapLimitMb > 0 && heapBefore !== null && heapAfter !== null) {
          expect(heapAfter - heapBefore, `${site}: heap grew ${heapAfter - heapBefore} MB over the deep scroll (limit ${heapLimitMb} MB; set E2E_DEEP_SCROLL_HEAP_LIMIT_MB to tune or 0 to disable)`).toBeLessThanOrEqual(heapLimitMb);
        }
      },
      DEEP_SCROLL_TIMEOUT_MS,
    );
  }

  test("facebook: feed posts mount distinct keys (no shared-photo collisions)", async () => {
    const b = fx.need();
    await gotoSettled(b, authFeedUrl("facebook"), 4500);
    const { maxVisible } = await scrollAndCountHosts(b, "facebook", 5);
    expect(maxVisible, noHostMounted("facebook")).toBeGreaterThan(0);
    const ev = await readEvidence(b, "facebook");
    // A single-photo post keys on its media id (`photo:<media>`) - the
    // one identity shared by the feed card, the permalink and the photo viewer, so
    // photo-keyed anchors are EXPECTED. The real invariant is that two DISTINCT
    // posts never collide on one key (the two-posts-one-photo class): distinct
    // anchors must carry distinct keys.
    const dupes = ev.mountKeys.filter((k, i) => ev.mountKeys.indexOf(k) !== i);
    expect(dupes, `two posts must not share one target key (e.g. a reshared photo's media id). Duplicate keys: ${JSON.stringify(dupes)}`).toHaveLength(0);
    // The inverse invariant: one post must never carry two pickers. The two
    // hosts can sit on DIFFERENT keys (a second host in the page-admin
    // "View insights / Boost post" tools row steals the post's photo key and
    // re-keys the real action row onto the CFT fallback), so the duplicate-key
    // check above cannot catch this class. Reproduces on the admin's OWN fresh
    // post - point E2E_AUTHURL_FACEBOOK at your page/group to exercise it.
    expect(ev.multiAnchorPostCount, "a post must never mount two pickers (e.g. one in the admin View insights / Boost post row)").toBe(0);
  });

  test("facebook: hovering post dates does not flip the host or pop a tooltip", async () => {
    const b = fx.need();
    await gotoSettled(b, authFeedUrl("facebook"), 4500);
    expect(await waitForHost(b, "facebook", 12_000), noHostMounted("facebook")).toBeGreaterThan(0);
    const before = await readEvidence(b, "facebook");
    // Real hover over the post date/permalink links (what triggers FB's lazy
    // hydration + the tooltip artifact). Trusted hover via Playwright.
    // The two waits inside are hydration beats, not arbitrary: FB fetches the hovercard
    // after a dwell (150ms per link), and the trailing 800ms lets the last one land.
    await b.act(
      `const links = await page.locator('div[role="article"] a[role="link"]').elementHandles();
       for (const h of links.slice(0, 8)) { try { await h.hover({ timeout: 1000 }); await page.waitForTimeout(150); } catch {} }
       await page.waitForTimeout(800);`,
    );
    const after = await readEvidence(b, "facebook");
    expect(after.roleTooltipCount, "no stray FB date tooltip should remain visible").toBe(0);
    expect(after.visibleHostCount >= before.visibleHostCount, "hosts must not disappear/flip when post dates are hovered").toBe(true);
    expect(after.duplicateKeys.length, "date hover must not duplicate a target").toBe(0);
  });

  test("reddit: hosts return after scrolling down then back up (virtualization)", async () => {
    const b = fx.need();
    await gotoSettled(b, authFeedUrl("reddit"), 4000);
    const down = await scrollAndCountHosts(b, "reddit", 6);
    expect(down.maxVisible, noHostMounted("reddit")).toBeGreaterThan(0);
    // Two wheels with a beat between them: one 8000px jump is swallowed by Reddit's
    // virtualizer, which recycles rows per scroll event rather than per pixel.
    await b.act(`${wheelBySrc("-4000")} await page.waitForTimeout(300); ${wheelBySrc("-4000")}`);
    await b.waitMs(1800);
    const top = await readEvidence(b, "reddit");
    expect(top.visibleHostCount, "top-zone hosts should return after scrolling back up").toBeGreaterThan(0);
    expect(top.duplicateKeys.length).toBe(0);
  });

  // Scroll into a permalink's comment area. Detail pages often keep the scroll
  // inside an inner container (FB permalinks especially), and page.mouse.wheel
  // scrolls whatever is under the pointer - so park the pointer mid-viewport
  // first.
  async function scrollIntoComments(b: ReturnType<typeof fx.need>, steps = 3): Promise<void> {
    await b.act(
      `const vp = page.viewportSize() || { width: 1200, height: 800 };
       await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
       // 700ms per step: the comment thread loads a page at a time, and scrolling past a
       // pending fetch skips the very units this walk is counting.
       for (let i = 0; i < ${steps}; i++) { ${wheelBySrc("900")} await page.waitForTimeout(700); }`,
    );
    await b.waitMs(1500);
  }

  // Comment surfaces: the picker belongs to the post; comment rows carry their
  // own like/vote controls but must never mount an Emojery host. Reddit gets a
  // structural check (comments are <shreddit-comment> elements); FB/IG post pages
  // assert the single-picker contract survives the comment area loading in.
  test(
    "reddit: comment thread mounts no pickers inside comments",
    async () => {
      const b = fx.need();
      await gotoSettled(b, authContentUrl("reddit"), 4000);
      expect(await waitForHost(b, "reddit", PERMALINK_HOST_WAIT_MS), "reddit: no Emojery host on the post permalink - log into Reddit in the connected Chrome.").toBeGreaterThan(0);
      await scrollIntoComments(b);
      // Anchors can live inside shadow roots, and closest() does not cross them -
      // walk shadow hosts upward before deciding "inside a comment".
      const anchorsInComments = await b.evaluate<number>(
        `${DQ_SRC}
       const insideComment = (el) => {
         let node = el;
         while (node) {
           if (node.closest && node.closest('shreddit-comment')) return true;
           const root = node.getRootNode ? node.getRootNode() : null;
           node = root && root.host ? root.host : null;
         }
         return false;
       };
       return dq('[data-khasky-emojery-mounted]').filter((a) => a.isConnected && insideComment(a)).length;`,
      );
      expect(anchorsInComments, "no Emojery anchor may sit inside a reddit comment").toBe(0);
      const ev = await readEvidence(b, "reddit");
      expect(ev.duplicateKeys.length).toBe(0);
    },
    PERMALINK_TEST_TIMEOUT_MS,
  );

  for (const site of ["facebook", "instagram"] as const) {
    test(
      `${site}: post permalink keeps exactly one picker while comments load`,
      async () => {
        const b = fx.need();
        await gotoSettled(b, authContentUrl(site), 4000);
        expect(await waitForHost(b, site, PERMALINK_HOST_WAIT_MS), `${site}: no Emojery host on the post permalink - log into ${site} in the connected Chrome.`).toBeGreaterThan(0);
        await scrollIntoComments(b);
        const ev = await readEvidence(b, site);
        // Why the dialog scopes the check: see postSurfaceHosts.
        expect(postSurfaceHosts(ev).length, `${site}: a post permalink must keep exactly one visible picker on the post's surface - extra ones mean the comment area (or a re-render) mounted its own`).toBe(1);
        expect(ev.duplicateKeys.length).toBe(0);
      },
      PERMALINK_TEST_TIMEOUT_MS,
    );
  }

  // Threads "thread" units render the main post plus reply previews as SIBLING
  // pressables inside one `[data-pagelet]` unit, each reply with its own full
  // action row - the picker belongs to the main (first) post only; a reply
  // preview must never mount one. Driven from the replies-tab fixture, not the
  // home feed: the feed carries the shape too rarely to check against (see
  // authThreadsRepliesUrl). Scroll-audited because that surface virtualizes
  // units in and out; skips when this run surfaced no reply previews.
  test(
    "threads: reply previews mount no pickers (main post only)",
    async (ctx) => {
      const b = fx.need();
      await gotoSettled(b, authThreadsRepliesUrl(), 4500);
      expect(await waitForHost(b, "threads", PERMALINK_HOST_WAIT_MS), noHostMounted("threads")).toBeGreaterThan(0);
      let replyUnits = 0;
      let strayHosts = 0;
      for (let step = 0; step < 8; step++) {
        const audit = await b.evaluate<{ replyUnits: number; strayHosts: number }>(
          `const units = [...document.querySelectorAll('[data-pagelet]')];
         let replyUnits = 0, strayHosts = 0;
         for (const u of units) {
           const pressables = [...u.querySelectorAll('[data-pressable-container]')];
           if (pressables.length < 2) continue;
           // A quote's nested pressable lives INSIDE the first; a reply preview
           // is a sibling AFTER it - only sibling units are this bug's shape.
           const siblings = pressables.filter((p) => p !== pressables[0] && !pressables[0].contains(p));
           if (siblings.length === 0) continue;
           replyUnits++;
           const hosts = [...u.querySelectorAll('.khasky-emojery-host')].filter((h) => h.getBoundingClientRect().width > 0);
           strayHosts += hosts.filter((h) => !pressables[0].contains(h)).length;
         }
         return { replyUnits, strayHosts };`,
        );
        replyUnits += audit.replyUnits;
        strayHosts += audit.strayHosts;
        // 900ms: Threads renders reply previews lazily, so the next audit round needs the
        // freshly scrolled-in units to exist before it counts them.
        await b.act(`${wheelBySrc("1000")} await page.waitForTimeout(900);`);
      }
      if (replyUnits === 0) {
        // Separate "no reply previews on this surface right now" from "Meta
        // renamed the Threads internals this audit walks": the second would skip
        // forever with the same message, and nothing tracks consecutive skips for
        // the vitest bridge suites - so prove the selector is still alive first.
        const pressableContainers = await b.evaluate<number>(`return document.querySelectorAll('[data-pressable-container]').length;`);
        expect(pressableContainers, "threads: [data-pressable-container] is gone - the audit is blind, not idle").toBeGreaterThan(0);
        ctx.skip(); // the account behind E2E_AUTHURL_THREADS_REPLIES has no reply units - point it at an active one
      }
      expect(strayHosts, "a reply preview in a threads unit must never mount a picker - only the unit's main (first) post may").toBe(0);
    },
    PERMALINK_TEST_TIMEOUT_MS,
  );

  // Group posts resolve their identity differently from feed/profile posts, so
  // the group surface gets its own mount/no-dup pass. The default URL is the
  // signed-in account's aggregated groups feed; with no group membership there
  // is nothing to test - that skips (setup), while "articles but no hosts" fails
  // (a real adapter regression).
  test("facebook: group feed mounts hosts with no duplicate keys", async (ctx) => {
    const b = fx.need();
    await gotoSettled(b, authFacebookGroupUrl(), 4500);
    const articles = await b.run<number>(`return await page.locator('div[role="article"]').count().catch(() => 0);`);
    if (articles === 0) {
      ctx.skip(); // no group posts - set E2E_WARMUP_FACEBOOK_GROUP (auto-join+leave) or E2E_AUTHURL_FACEBOOK_GROUP
    }
    const { maxVisible, sawDuplicate } = await scrollAndCountHosts(b, "facebook", 5);
    expect(maxVisible, "facebook groups: posts are present but no Emojery host mounted").toBeGreaterThan(0);
    expect(sawDuplicate, "a group feed must not leave duplicate target keys").toBe(false);
    const ev = await readEvidence(b, "facebook");
    expect(ev.multiAnchorPostCount, "a group post must never carry two pickers").toBe(0);
  });

  // Carousel (multi-image) posts re-render their media region on every swipe;
  // the picker must stay a single host with a stable key through that.
  test(
    "instagram: carousel keeps a single picker across slide swipes",
    async (ctx) => {
      const url = authInstagramCarouselUrl();
      if (!url) {
        ctx.skip(); // point E2E_AUTHURL_INSTAGRAM_CAROUSEL at a stable multi-image post
      }
      const b = fx.need();
      await gotoSettled(b, url as string, 4000);
      expect(await waitForHost(b, "instagram", PERMALINK_HOST_WAIT_MS), "instagram: no Emojery host on the carousel post - log into Instagram in the connected Chrome.").toBeGreaterThan(0);
      const before = await readEvidence(b, "instagram");
      const keyBefore = before.mountKeys.find((k) => k.startsWith("instagram:")) ?? null;
      expect(keyBefore, "the carousel post should mount an instagram-keyed anchor").not.toBeNull();

      // The Next arrow's aria-label follows the ACCOUNT language, so match the common
      // ones (EN "Next" + RU/UA/ES/DE/FR). If none matches, this is a setup/locale
      // mismatch, not a product bug.
      const nextArrow = ["Next", "Далее", "Далі", "Siguiente", "Weiter", "Suivant"].map((label) => `button[aria-label="${label}"]`).join(", ");
      const hasNext = await b.run<number>(`return await page.locator(${JSON.stringify(nextArrow)}).filter({ visible: true }).count().catch(() => 0);`);
      if (hasNext === 0) {
        ctx.skip(); // not a carousel (or non-English account UI) - adjust E2E_AUTHURL_INSTAGRAM_CAROUSEL
      }
      for (let i = 0; i < 2; i++) {
        await b.act(`await page.locator(${JSON.stringify(nextArrow)}).filter({ visible: true }).first().click({ timeout: 5000 }).catch(() => {});`);
        await b.waitMs(1200);
      }
      const after = await readEvidence(b, "instagram");
      expect(after.visibleHostCount, "swiping carousel slides must not add or drop pickers").toBe(before.visibleHostCount);
      expect(after.duplicateKeys.length, "swiping must not duplicate the target").toBe(0);
      expect(after.mountKeys.find((k) => k.startsWith("instagram:")) ?? null, "the carousel's target key must stay stable across swipes").toBe(keyBefore);
    },
    PERMALINK_TEST_TIMEOUT_MS,
  );
});
