// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared by the facebook injection specs: each one injects a synthetic row into
// a live post page, so the page's OWN post has to mount first - and a page that
// never mounts is a wall (skip), not a regression.
import { expect, type Page, test } from "@playwright/test";
import { DEEP_QUERY_ALL_SRC } from "./probe-src";
import { isBlockUrl } from "./site-walls";

export async function requireFacebookPostMount(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let mounted = false;
  while (Date.now() < deadline && !mounted) {
    mounted = await page
      .evaluate<boolean>(`(() => {
        ${DEEP_QUERY_ALL_SRC}
        return deepQueryAll("[data-khasky-emojery-mounted]").some((el) => el.getBoundingClientRect().width > 0);
      })()`)
      .catch(() => false);
    // Poll interval, bounded by the loop above: the mount is IntersectionObserver-driven,
    // so there is no event to await - only the marker appearing.
    if (!mounted) await page.waitForTimeout(500);
  }
  if (!mounted) {
    test.skip(isBlockUrl(page.url()), `Navigation blocked on facebook (${page.url()})`);
  }
  expect(mounted, "the post itself must mount first").toBe(true);
}
