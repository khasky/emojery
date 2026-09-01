// SPDX-License-Identifier: GPL-3.0-or-later
//
// Threads' photo lightbox is a URL-addressed overlay: opening a photo pushes
// `/@user/post/<id>/media` (the photo OWNER's id) over a page whose DOM does
// not change. The scan is suspended for that URL (threads.ts suspendScan) -
// otherwise the overlay's id mounted the photo owner's trigger behind the
// lightbox and the close tore it down again: a visible blink on every cycle,
// and a stale wrong-post trigger whenever the teardown scan lost the race
// (bug: parent post's pill flickering on a reply's page).
//
// The regression check needs no real photo click: the extension reacts to the
// pathname alone, so pushState/back reproduce the exact transition. The
// invariant: a lightbox open/close cycle changes NOTHING about the mounts.

import { expect, type Page, test } from "@playwright/test";
import { envUrl } from "./lib/extension";
import { gotoSettled } from "./lib/page-settle";
import { pollForValue } from "./lib/picker-probes";
import { DEEP_QUERY_ALL_SRC } from "./lib/probe-src";
import { sharedSession } from "./lib/shared-session";
import { isBlockUrl } from "./lib/site-walls";

const THREADS_POST = envUrl("THREADS_POST");
const MOUNT_TIMEOUT_MS = Number(process.env.E2E_OVERLAY_MOUNT_TIMEOUT_MS ?? 25_000);
// Past the urlChangeRescan settle delays (0/350/800ms), so a scan that WOULD
// react to the overlay URL has had every chance to run before the read.
const OVERLAY_SETTLE_MS = 2_000;

const session = sharedSession();

// Visible mounted-anchor keys, sorted - the whole page state this spec asserts on.
async function visibleMountKeys(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    return deepQueryAll("[data-khasky-emojery-mounted]")
      .filter((el) => el.getBoundingClientRect().width > 0)
      .map((el) => el.getAttribute("data-khasky-emojery-mounted"))
      .sort();
  })()`);
}

test("a threads /media overlay cycle leaves the mounts untouched", async () => {
  const page = await session().context.newPage();
  try {
    await gotoSettled(page, THREADS_POST);

    const before = await pollForValue(
      () => visibleMountKeys(page).catch(() => [] as string[]),
      (keys) => keys.length > 0,
      MOUNT_TIMEOUT_MS,
    );
    if (before.length === 0) {
      test.skip(isBlockUrl(page.url()), `Navigation blocked on threads (${page.url()})`);
    }
    expect(before.length, "the fixture post must mount its trigger first").toBeGreaterThan(0);

    // "Open the lightbox": only the pathname changes, exactly like the real
    // click. The overlay id is a DIFFERENT post's on purpose - the bug's shape
    // is a reply page whose lightbox belongs to the PARENT post (the photo
    // owner), so the overlay URL must not match the page's own target: the
    // pre-fix scan then unmounted the focal trigger for the overlay's id.
    await page.evaluate(() => {
      history.pushState({}, "", "/@emojery.e2e.fixture/post/AAAAAAAAAAA/media");
    });
    await page.waitForTimeout(OVERLAY_SETTLE_MS);
    expect(await visibleMountKeys(page), "the overlay URL must not mount or unmount anything").toEqual(before);

    await page.evaluate(() => {
      history.back();
    });
    await page.waitForTimeout(OVERLAY_SETTLE_MS);
    expect(await visibleMountKeys(page), "closing the overlay must restore the exact pre-open state").toEqual(before);
  } finally {
    await page.close().catch(() => {});
  }
});
