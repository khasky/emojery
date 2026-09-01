// SPDX-License-Identifier: GPL-3.0-or-later
//
// A Facebook comment's reaction cluster (a like-labeled `[role="button"]` whose
// text is the count) can sit shallow enough in its comment `[role="article"]`
// that the bounded sibling walk reaches the level whose SIBLING is the POST's
// own counts row - and the genuine, text-bearing comment-count chip there then
// "proves" a post action row. Every label-based guard is blind to that (the
// borrowed marker is a real post control), so the picker mounted on comments
// with large reaction clusters (user-reported feeds, UA UI; reproduced live by
// injecting the exact shape). The structural fix: a control
// inside a NESTED article is a comment's and is never a candidate
// (facebook-post-row.ts isInNestedArticle).
//
// This spec is deterministic where the live shape is not: Facebook A/B-serves
// the cluster aria (a bare like label vs a "Like: N people" count summary that
// the colon rule already rejects) per account/day, so instead of hoping for the
// vulnerable variant we INJECT it - a synthetic comment article carrying the
// bare-aria cluster, placed exactly where the walk can borrow the post's counts
// row - into the real, live post page next to the real counts row the adapter
// mounted on. The pre-fix build accepts it (verified live before the fix); the
// fixed build must never mount inside it.

import { expect, test } from "@playwright/test";
import { envUrl } from "./lib/extension";
import { requireFacebookPostMount } from "./lib/mount-wait";
import { gotoSettled } from "./lib/page-settle";
import { DEEP_QUERY_ALL_SRC } from "./lib/probe-src";
import { sharedSession } from "./lib/shared-session";

const FACEBOOK_POST = envUrl("FACEBOOK_POST");
const MOUNT_TIMEOUT_MS = Number(process.env.E2E_FB_INJECT_MOUNT_TIMEOUT_MS ?? 30_000);
// Past several scan/settle passes, so the injected candidate has had every
// chance to be (wrongly) accepted before the assert.
const INJECT_SETTLE_MS = Number(process.env.E2E_FB_INJECT_SETTLE_MS ?? 8_000);

const session = sharedSession();

test("a comment's reaction cluster never becomes a mount, even when it can see the post's counts row", async () => {
  const page = await session().context.newPage();
  try {
    await gotoSettled(page, FACEBOOK_POST);

    // The post's own mount doubles as the locator for its counts row.
    await requireFacebookPostMount(page, MOUNT_TIMEOUT_MS);

    // Inject the vulnerable shape next to the post's own row: a counts-row
    // comment chip (text-bearing, exactly like the logged-in counts row ships)
    // beside a comment article holding the bare-aria like cluster whose text is
    // the count. From the cluster, the bounded sibling walk reaches the chip -
    // the borrowed "post row" proof - within its window, which is the exact
    // acceptance the reporter's live pages produce. Verified accepted (anchor
    // claimed with the post's own target) on the pre-fix build.
    const injected = await page.evaluate<boolean>(`(() => {
      ${DEEP_QUERY_ALL_SRC}
      const anchor = deepQueryAll("[data-khasky-emojery-mounted]").find((el) => el.getBoundingClientRect().width > 0);
      if (!anchor) return false;
      const row = anchor.parentElement;
      const section = row && row.parentElement;
      if (!section) return false;
      const sec = document.createElement("div");
      const chip = document.createElement("div");
      chip.setAttribute("role", "button");
      chip.setAttribute("aria-label", "Залишити коментар");
      chip.setAttribute("tabindex", "0");
      chip.textContent = "91 988";
      chip.style.cssText = "display:inline-block;min-width:60px;min-height:16px;";
      sec.appendChild(chip);
      const art = document.createElement("div");
      art.setAttribute("role", "article");
      art.setAttribute("data-e2e-injected-comment", "1");
      const cluster = document.createElement("div");
      cluster.setAttribute("role", "button");
      cluster.setAttribute("aria-label", "Подобається");
      cluster.setAttribute("tabindex", "0");
      cluster.style.cssText = "display:inline-block;min-width:50px;min-height:16px;";
      const count = document.createElement("span");
      count.textContent = "14 тис.";
      cluster.appendChild(count);
      art.appendChild(cluster);
      sec.appendChild(art);
      section.appendChild(sec);
      return true;
    })()`);
    expect(injected, "the synthetic comment must land next to the post's row").toBe(true);

    await page.waitForTimeout(INJECT_SETTLE_MS);
    const commentMounts = await page.evaluate<number>(`(() => {
      ${DEEP_QUERY_ALL_SRC}
      const art = document.querySelector('[data-e2e-injected-comment="1"]');
      if (!art) return -1;
      let n = art.hasAttribute("data-khasky-emojery-mounted") ? 1 : 0;
      n += deepQueryAll("[data-khasky-emojery-mounted]").filter((el) => art.contains(el)).length;
      n += deepQueryAll(".khasky-emojery-host").filter((el) => art.contains(el)).length;
      return n;
    })()`);
    expect(commentMounts, "nothing may mount on or inside a comment article").toBe(0);
  } finally {
    await page.close().catch(() => {});
  }
});
