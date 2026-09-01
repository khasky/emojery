// SPDX-License-Identifier: GPL-3.0-or-later
//
// Selector drift probe: opens every scenario URL WITHOUT the extension and
// checks that the site still serves the native controls and containers the
// adapters anchor on. A site's DOM drift is caught hours before the placement
// sweep and without a build - and a red run names the exact selector group
// that died, which is the input a selector hot-patch needs. Runs on its own
// config and schedule (.github/workflows/selector-drift.yml); the main suite
// ignores e2e/selector-drift/**.
import { expect, test } from "@playwright/test";
import { envUrl } from "../lib/extension";
import { clickAmazonContinueShopping, dismissInterstitialsInitScript, wallReason } from "../lib/site-walls";
import { SUPPORTED_SITE_SCENARIOS } from "../supported-sites";

// Deep-count matches for each selector, descending into open shadow roots
// (Reddit's post shells). Serialized into the page - keep self-contained.
// No `seen` dedupe needed here, unlike the canonical walk (lib/probe-src.ts):
// each shadow root hangs off exactly one host, so every root is counted once.
function countSelectorsDeep(selectors: string[]): Array<{ sel: string; n: number }> {
  const countOne = (sel: string): number => {
    let n = 0;
    const visit = (root: ParentNode): void => {
      try {
        n += root.querySelectorAll(sel).length;
      } catch {
        // Engine-rejected selector literal: count stays 0 for this root.
      }
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return n;
  };
  return selectors.map((sel) => ({ sel, n: countOne(sel) }));
}

// Controls named by TEXT, not aria-label - Facebook's logged-out action row, which
// the adapter reads the same way (facebook-post-row.ts matchesActionLabel).
function countTextLabelsDeep(labels: string[]): Array<{ sel: string; n: number }> {
  const countOne = (label: string): number => {
    let n = 0;
    const visit = (root: ParentNode): void => {
      for (const el of Array.from(root.querySelectorAll('[role="button"], button'))) {
        if ((el.textContent ?? "").trim() === label) n++;
      }
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.shadowRoot) visit(el.shadowRoot);
      }
    };
    visit(document);
    return n;
  };
  return labels.map((label) => ({ sel: `text=${label}`, n: countOne(label) }));
}

for (const site of SUPPORTED_SITE_SCENARIOS) {
  test(`${site.site}: ${site.label} scenario selectors alive`, async ({ page }) => {
    await page.addInitScript(dismissInterstitialsInitScript, { exposeUnwallHook: false, keepDialogsWithReactionHost: false });
    const navOk = await page.goto(envUrl(site.urlKey), { waitUntil: "domcontentloaded", timeout: 60_000 }).then(
      () => true,
      () => false,
    );
    test.skip(!navOk, `navigation blocked on ${site.site} (anti-bot / HTTP error)`);
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
    // Amazon gates an automated browser twice: a throttle page whose button
    // lands on the homepage, and an ads-notice dialog over the loaded product.
    // Cleared BEFORE and AFTER the settle, mirroring page-settle.ts - the
    // dialog can render a second after `load`, so a single early pass misses
    // it and every selector then reads as dead.
    await clickAmazonContinueShopping(page, envUrl(site.urlKey));
    await page.waitForTimeout(site.settleMs ?? 4_000);
    await clickAmazonContinueShopping(page, envUrl(site.urlKey));
    // Wheel jiggle: virtualized feeds render on scroll, and the pauses let the
    // lazy content paint before the selectors are counted.
    await page.mouse.wheel(0, 600);
    await page.waitForTimeout(1_500);
    await page.mouse.wheel(0, -600);
    await page.waitForTimeout(1_000);

    // Count FIRST, decide second. A challenge parameter can outlive the
    // challenge itself: captured live, Reddit keeps `?js_challenge=` in the URL
    // after its own JS has solved it and set the `loid` cookie, while serving
    // the real post underneath. Skipping on the URL alone therefore threw away
    // a perfectly good page - the selectors ARE the ground truth, so a wall only
    // explains their absence, it never overrides their presence.
    const native = [...(await page.evaluate(countSelectorsDeep, site.nativeSelectors)), ...(site.nativeTextLabels?.length ? await page.evaluate(countTextLabelsDeep, site.nativeTextLabels) : [])];
    const containers = await page.evaluate(countSelectorsDeep, site.containerSelectors);
    if (!native.some((c) => c.n > 0)) {
      // An interstitial serves its own markup, so every scenario selector is
      // legitimately absent - reporting that as "the selectors died" would cry wolf
      // daily. The shared wallReason matches only EXACT wall sentences (never
      // site-walls' loose phrases), which is exactly what this probe needs: it has no
      // mount evidence to disambiguate a loose phrase with.
      const blocked = await wallReason(page);
      test.skip(blocked !== null, `${site.site}: ${blocked}`);
    }
    // One live selector per group keeps the adapter working (the lists are
    // fallback chains); a whole DEAD GROUP means the anchors are gone and the
    // e2e mount will fail next - that is the page-change signal to hot-patch.
    expect(
      native.some((c) => c.n > 0),
      `every native selector died on ${site.site}: ${JSON.stringify(native)}`,
    ).toBe(true);
    if (site.containerSelectors.length > 0) {
      expect(
        containers.some((c) => c.n > 0),
        `every container selector died on ${site.site}: ${JSON.stringify(containers)}`,
      ).toBe(true);
    }
  });
}
