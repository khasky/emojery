// SPDX-License-Identifier: GPL-3.0-or-later
//
// Getting a real, third-party page into a state worth asserting on: navigation
// that tolerates a dead URL, the per-site interstitial and login-wall
// dismissals, and the single deep DOM probe that turns the settled page into a
// MountEvidence record. lib/picker-probes.ts shares it; theme-contrast keeps
// its own lighter settle on purpose.
import type { Page } from "@playwright/test";
import { DEEP_QUERY_ALL_SRC, IS_VISIBLE_RECT_SRC, MOUNTED_KEY_OF_SRC, RECT_GEOMETRY_SRC } from "./probe-src";
import { DEFAULT_SCROLL_STEPS, type MountEvidence, type SupportedSiteScenario } from "./site-evidence";
import { clickAmazonContinueShopping, dismissDialogWall, dismissLoginWalls, INTERSTITIAL_PHRASES, interstitialTextRe, isBlockUrl } from "./site-walls";
export async function safeGoto(page: Page, url: string): Promise<boolean> {
  try {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    return true;
  } catch {
    return false;
  }
}
export async function safeReload(page: Page): Promise<boolean> {
  try {
    await page.reload({ waitUntil: "domcontentloaded" });
    return true;
  } catch {
    return false;
  }
}

// The bounded full-load wait behind gotoSettled, exported on its own for legs
// that navigate elsewhere (site-injection owns its safeGoto/safeReload calls).
// A live site can hold sockets open past any budget, so "load" is awaited but
// never fatal.
export async function settleFullLoad(page: Page): Promise<void> {
  await page.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
}

// The shared navigate-and-settle idiom: DOMContentLoaded gets the page, then the
// full load gets its bounded, non-fatal chance to finish. By default a
// navigation error throws, failing the caller on the raw error;
// `tolerateNavError` swallows it instead and the return value says whether
// navigation itself succeeded (theme-contrast turns a blocked navigation into a
// skip, private-pages rewrites the served document mid-route).
export async function gotoSettled(page: Page, url: string, opts: { tolerateNavError?: boolean } = {}): Promise<boolean> {
  let navOk = true;
  if (opts.tolerateNavError) {
    navOk = await safeGoto(page, url);
  } else {
    await page.goto(url, { waitUntil: "domcontentloaded" });
  }
  await settleFullLoad(page);
  return navOk;
}

export function isNoActionSurface(evidence: MountEvidence): boolean {
  // Trust a real, visible, correctly-placed host over the URL: if our trigger
  // actually mounted next to the native action, the page rendered a usable
  // surface, so an anti-bot token in the URL must NOT skip the run. Reddit's
  // js_challenge shell still SSRs the real post and its vote row (verified by
  // screenshot - our trigger mounts on it). This runs BEFORE isBlockUrl so such a
  // run is tested for real (a replaceNative leg then asserts against the actual
  // DOM instead of hiding behind a URL skip).
  if (evidence.matchingAnchorKeys.length > 0 && evidence.placementOk && evidence.visibleMatchingHostCount >= 1) {
    return false;
  }
  // Nothing usable mounted - a block / login-wall / anti-bot URL (Instagram
  // /accounts/login, FB /checkpoint, a ?next= redirect, or a js_challenge shell
  // that rendered no post) means the browser was walled - skip, not false-fail.
  if (isBlockUrl(evidence.url)) return true;
  if (evidence.matchingAnchorKeys.length > 0 || evidence.placementOk) return false;
  return evidence.visibleNativeCount === 0 || hasInterstitialText(evidence);
}

// Shortest a settle pass may take. Without it a caller whose condition is already
// satisfied spins evidence passes back-to-back against a live site.
const SETTLE_FLOOR_MS = 250;

const INTERSTITIAL_TEXT = interstitialTextRe("rate.?limit");

// Unambiguous anti-bot / transient-error interstitial text (no normal post page
// renders this). Needed because Threads' interstitial keeps its nav chrome,
// which matches the broad native selectors - a pure no-visible-native check
// misses it. Also bails the evidence wait instantly: scrolling can't reveal a
// post that isn't there, and on the long authed flow every wasted second risks
// the E2E_AUTHED_SITE_TIMEOUT_MS budget firing before the no-action-surface skip.
export function hasInterstitialText(evidence: MountEvidence): boolean {
  return INTERSTITIAL_TEXT.test(evidence.bodyTextSample);
}

// A content-level login wall the URL check (isBlockUrl) misses: a logged-out
// Facebook/Instagram page still SSRs the post - our host mounts and places on it -
// but overlays its sign-in form, so the native Like is login-gated and
// replaceNative has no real control to hide. "Forgot account?"/"Forgot password?"
// is unique to that signed-out form (authenticated pages never render it), so it
// pins the logged-out state without false-skipping a normally-served page.
export function hasLoginWallText(evidence: MountEvidence): boolean {
  return /forgot(ten)? account\?|forgot password\?/i.test(evidence.bodyTextSample);
}

// The scroll-pass loop every wait helper here (and in picker-probes.ts) shares:
// walk the site's scroll steps, settle, probe, and stop the moment `satisfied`
// accepts a reading. Returns the LAST reading, or null when nothing was probed.
// The settle differs per caller, so it arrives as a callback.
//
// The deadline is also checked INSIDE the pass: a pass entered just before it
// otherwise runs every remaining scroll step (a settle + a full probe each) and
// overruns the budget by seconds.
export async function scrollPassUntil<T>(page: Page, scrollSteps: number[], deadline: number, settle: (page: Page) => Promise<void>, probe: () => Promise<T>, satisfied: (value: T) => boolean): Promise<T | null> {
  let last: T | null = null;

  while (Date.now() < deadline) {
    for (const y of scrollSteps) {
      if (Date.now() >= deadline) break;
      await page.evaluate((top) => window.scrollTo({ top, behavior: "auto" }), y);
      await settle(page);
      last = await probe();
      if (satisfied(last)) return last;
    }
  }

  return last;
}

// The mirror image of waitForMountEvidence, for a site the popup just switched
// OFF: wait for evidence that the page reached its DISABLED signature rather
// than for a mount. `mount.ts` claims the anchor BEFORE it reads settings, so
// "anchors present, zero hosts" is what a disabled site looks like - and either
// signal ends the wait, so a re-enabled site is not waited out to the deadline.
export async function waitForDisabledSiteEvidence(page: Page, site: SupportedSiteScenario): Promise<MountEvidence> {
  const last = await scrollPassUntil(
    page,
    site.scrollSteps ?? DEFAULT_SCROLL_STEPS,
    Date.now() + Number(process.env.E2E_SITE_TIMEOUT_MS ?? 70_000),
    (p) => settlePage(p, site),
    () => collectMountEvidence(page, site),
    (evidence) => evidence.matchingAnchorKeys.length > 0 || evidence.matchingHostCount > 0,
  );

  return last ?? (await collectMountEvidence(page, site));
}

export async function waitForMountEvidence(page: Page, site: SupportedSiteScenario, expectHiddenNative = false): Promise<MountEvidence> {
  const scrollSteps = site.scrollSteps ?? DEFAULT_SCROLL_STEPS;
  const deadline = Date.now() + Number(process.env.E2E_SITE_TIMEOUT_MS ?? 70_000);
  let last: MountEvidence | null = null;
  // A page with no post action surface (login wall / anti-bot / transient error -
  // see isNoActionSurface) has nothing to mount on. Counted across full passes so
  // a slow first paint doesn't trip it; returning early then keeps the caller's
  // tightly-guarded test.skip inside the test budget - a slow walled page once
  // burnt the whole 70s evidence wait and overran the 120s default before the
  // skip could run. This per-PASS accounting (and the mid-pass reveal below) is
  // why this one keeps its own loop instead of using scrollPassUntil.
  let wallPasses = 0;

  while (Date.now() < deadline) {
    for (const y of scrollSteps) {
      // Also checked INSIDE the pass (same reason as scrollPassUntil): the
      // remaining steps of a pass entered just before the deadline would run
      // past it, and this wait sits inside the caller's own test budget.
      if (Date.now() >= deadline) break;
      await page.evaluate((top) => window.scrollTo({ top, behavior: "auto" }), y);
      await settlePage(page, site);
      last = await collectMountEvidence(page, site);
      // An interstitial won't become a post by scrolling or waiting - bail immediately.
      if (hasInterstitialText(last)) return last;
      if (last.matchingAnchorKeys.length > 0 && last.visibleMatchingHostCount < 1) {
        await revealMountTarget(page, site);
        await settlePage(page, site);
        last = await collectMountEvidence(page, site);
      }
      // When the caller expects native replacement, also wait for the natives to
      // actually be hidden - the host mounts as soon as its row is found, but the
      // hide can land a beat later, so returning on placement alone races it.
      // On a block / anti-bot challenge shell native-hiding may never land (the
      // shell displaces the real control), so a good mount is enough to stop
      // waiting - the caller skips only the unverifiable hidden-native leg.
      if (last.matchingAnchorKeys.length > 0 && last.visibleMatchingHostCount >= 1 && last.placementOk && (!expectHiddenNative || last.hiddenNativeCount > 0 || isBlockUrl(last.url))) {
        return last;
      }
    }
    wallPasses = last && isNoActionSurface(last) ? wallPasses + 1 : 0;
    // `last!` is sound: two wall passes require `last` truthy on both of them.
    if (wallPasses >= 2) return last!;
  }

  return last ?? (await collectMountEvidence(page, site));
}

async function revealMountTarget(page: Page, site: SupportedSiteScenario): Promise<void> {
  await page
    .evaluate(`(() => {
      // Pattern comes from a suite fixture, never from input.
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const pattern = new RegExp(${JSON.stringify(site.mountKeyPattern)});
      ${DEEP_QUERY_ALL_SRC}
      const anchors = Array.from(deepQueryAll("[data-khasky-emojery-mounted]"));
      const matchingAnchor = anchors.find((anchor) => pattern.test(anchor.getAttribute("data-khasky-emojery-mounted") ?? ""));
      const host = matchingAnchor?.parentElement?.querySelector(".khasky-emojery-host") ?? deepQueryAll(".khasky-emojery-host")[0];
      (host ?? matchingAnchor)?.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "auto",
      });
    })()`)
    .catch(() => {});
}

export async function settlePage(page: Page, site: SupportedSiteScenario): Promise<void> {
  const settleMs = site.settleMs ?? 2_000;
  await handleKnownInterstitials(page, site);
  await dismissLoginWalls(page);
  // Condition-first settle: a mounted host or a rendered native control means
  // the page is ready for evidence collection - stop waiting the moment either
  // appears. settleMs is only the CEILING, paid in full solely by pages that
  // never render one (walls, slow SSR).
  const settleStart = Date.now();
  await page
    .waitForFunction(
      (nativeSelectors) => {
        if (document.querySelector(".khasky-emojery-host")) return true;
        return nativeSelectors.some((sel) => {
          try {
            return document.querySelector(sel) !== null;
          } catch {
            return false;
          }
        });
      },
      site.nativeSelectors,
      { timeout: settleMs },
    )
    .catch(() => {});
  // Floor: see SETTLE_FLOOR_MS.
  const elapsed = Date.now() - settleStart;
  if (elapsed < SETTLE_FLOOR_MS) await page.waitForTimeout(SETTLE_FLOOR_MS - elapsed);
  await handleKnownInterstitials(page, site);
  await dismissLoginWalls(page);
}

export async function handleKnownInterstitials(page: Page, site: SupportedSiteScenario): Promise<void> {
  if (site.site === "amazon") await clickAmazonContinueShopping(page, site.url);
  await dismissDialogWall(page, site.site);
  // Threads ONLY: recover from its full-page anti-bot interstitial. Deliberately
  // NOT generalized - other sites carry the same wording in ordinary content
  // (Amazon "temporarily unavailable" / "try again"), and a global check
  // false-matched and reloaded healthy pages into their robot wall
  // (Amazon/YouTube went red). Elsewhere a genuine wall is handled by the skip.
  if (site.site === "threads") await recoverFromTransientInterstitial(page);
}

// Threads' "Something went wrong ... Retry" interstitial is usually TRANSIENT, so
// actively recover - click Retry, else reload - for a couple of short, bounded
// attempts so the real post renders and the test PASSES rather than skipping
// (a long retry loop once tipped a rate-limited run into the 120s timeout). A
// hard login wall carries no such error text and is left for the caller's
// isNoActionSurface skip - reloading can't reveal a post that requires signing in.
// Narrower than INTERSTITIAL_TEXT on purpose: a rate-limit page is not something a
// Retry click or a reload fixes, so this matches the shared phrase set with no extras.
async function recoverFromTransientInterstitial(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // The phrases travel as an argument: an evaluate body cannot close over the
    // module binding, and re-typing the phrases here is how the two copies drifted before.
    const hasError = await page
      .evaluate((phrases) => {
        const text = (document.body?.textContent ?? "").replace(/\s+/g, " ").toLowerCase();
        return phrases.some((phrase) => text.includes(phrase));
      }, INTERSTITIAL_PHRASES)
      .catch(() => false);
    if (!hasError) return;
    const retry = page.getByRole("button", { name: /retry|try again/i }).first();
    if (await retry.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await retry.click({ timeout: 3_000 }).catch(() => {});
    } else {
      await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await page.waitForLoadState("load", { timeout: 12_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
  }
}

// The single deep probe that turns a settled page into a MountEvidence record.
// A SOURCE-STRING evaluate body - see probe-src.ts for why, and for the two
// rules when editing one (no `${...}`, every regex backslash doubled).
// Everything it needs from the scenario arrives in one interpolated JSON literal.
export async function collectMountEvidence(page: Page, site: SupportedSiteScenario): Promise<MountEvidence> {
  const probeInput = JSON.stringify({
    mountKeyPattern: site.mountKeyPattern,
    nativeSelectors: site.nativeSelectors,
    containerSelectors: site.containerSelectors,
    requiredHostAncestorSelectors: site.requiredHostAncestorSelectors ?? [],
    maxY: site.maxVerticalDistance ?? 160,
    maxX: site.maxHorizontalDistance ?? 700,
  });

  return page.evaluate<MountEvidence>(`(() => {
    const { mountKeyPattern, nativeSelectors, containerSelectors, requiredHostAncestorSelectors, maxY, maxX } = ${probeInput};
    // Pattern comes from a suite fixture, never from input.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const pattern = new RegExp(mountKeyPattern);

    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    ${MOUNTED_KEY_OF_SRC}

    ${RECT_GEOMETRY_SRC}

    const insideOrOverlaps = (a, b) => {
      const horizontalOverlap = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      // Sub-pixel layout and rounded borders let a real child sit a hair outside its
      // container's box, so containment is checked with a slack band, not exactly.
      const slack = 12;
      return (a.left >= b.left - slack && a.right <= b.right + slack && a.top >= b.top - slack && a.bottom <= b.bottom + slack) || (horizontalOverlap > 0 && verticalOverlap > 0);
    };

    const bodyTextSample = () => {
      const clone = document.body?.cloneNode(true);
      if (!clone) return "";
      for (const node of Array.from(clone.querySelectorAll("script, style, noscript, template"))) node.remove();
      return (clone.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 500);
    };

    const hosts = deepQueryAll(".khasky-emojery-host");
    const anchors = deepQueryAll("[data-khasky-emojery-mounted]");
    const hiddenNativeEls = deepQueryAll('[data-khasky-emojery-hidden="1"]');
    const nativeEls = nativeSelectors.flatMap((selector) => deepQueryAll(selector));
    const containerEls = containerSelectors.flatMap((selector) => deepQueryAll(selector));

    const hiddenNativeSamples = hiddenNativeEls.map((el) => {
      const cs = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(),
        text: (el.textContent ?? "").replace(/\\s+/g, " ").trim().slice(0, 120),
        rect: rectOf(el),
        display: cs.display,
        visibility: cs.visibility,
      };
    });

    const hostSamples = hosts.map((host) => {
      const root = host.getRootNode();
      const rect = rectOf(host);
      const cs = getComputedStyle(host);
      let zeroAncestor = null;
      let ancestor = host.parentElement;
      while (ancestor && ancestor !== document.body) {
        const ancestorStyle = getComputedStyle(ancestor);
        const ancestorRect = ancestor.getBoundingClientRect();
        if (ancestorStyle.display === "none" || ancestorStyle.visibility === "hidden" || ancestorRect.width === 0 || ancestorRect.height === 0) {
          zeroAncestor = [
            ancestor.tagName.toLowerCase(),
            ancestor.getAttribute("role") ? '[role="' + ancestor.getAttribute("role") + '"]' : "",
            ancestor.getAttribute("aria-label") ? '[aria-label="' + ancestor.getAttribute("aria-label") + '"]' : "",
            ancestor.id ? "#" + ancestor.id : "",
            ancestor.className && typeof ancestor.className === "string" ? "." + ancestor.className.split(/\\s+/).filter(Boolean).slice(0, 3).join(".") : "",
            "display=" + ancestorStyle.display,
            "visibility=" + ancestorStyle.visibility,
            "rect=" + Math.round(ancestorRect.width) + "x" + Math.round(ancestorRect.height),
          ]
            .filter(Boolean)
            .join(" ");
          break;
        }
        ancestor = ancestor.parentElement;
      }
      const trigger = host.shadowRoot?.querySelector(".khasky-emojery-trigger, .khasky-emojery-counter, button") ?? null;
      return {
        mountKey: mountedKeyOf(host),
        text: (trigger?.textContent ?? host.textContent ?? "").replace(/\\s+/g, " ").trim(),
        visible: isVisibleRect(rect),
        rect,
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        offset: { width: host.offsetWidth, height: host.offsetHeight },
        zeroAncestor,
        root: root instanceof ShadowRoot ? "shadow" : "document",
      };
    });

    const nativeRects = nativeEls.map(rectOf).filter(isVisibleRect);
    const containerRects = containerEls.map(rectOf).filter(isVisibleRect);
    const anchorKeys = anchors.map((anchor) => anchor.getAttribute("data-khasky-emojery-mounted") ?? "").filter(Boolean);
    const matchingAnchorKeys = anchorKeys.filter((key) => pattern.test(key));
    const matchingHostSamples = hostSamples.filter((host) => (host.mountKey ? pattern.test(host.mountKey) : false));
    const matchingHosts = hosts.filter((host) => {
      const mountKey = mountedKeyOf(host);
      return mountKey ? pattern.test(mountKey) : false;
    });
    const hostRects = matchingHostSamples.filter((h) => h.visible).map((h) => h.rect);

    let closestNativeDistance = null;
    let nativeNear = false;
    for (const hostRect of hostRects) {
      for (const nativeRect of nativeRects) {
        const d = distance(hostRect, nativeRect);
        closestNativeDistance = closestNativeDistance === null ? d : Math.min(closestNativeDistance, d);
        if (near(hostRect, nativeRect)) nativeNear = true;
      }
    }

    const containerNear = hostRects.some((hostRect) => containerRects.some((containerRect) => insideOrOverlaps(hostRect, containerRect)));
    const placementOk = nativeNear || containerNear;
    const placementReason = nativeNear ? "host is near a native action" : containerNear ? "host is inside/overlapping an expected action container" : "host is not near expected native actions or containers";

    // Visual-correctness signals beyond proximity.
    const keyCounts = {};
    for (const key of matchingAnchorKeys) keyCounts[key] = (keyCounts[key] ?? 0) + 1;
    const duplicateMatchingKeys = Object.keys(keyCounts).filter((key) => (keyCounts[key] ?? 0) > 1);

    let maxHostNativeOverlapRatio = 0;
    for (const host of matchingHostSamples) {
      if (!host.visible) continue;
      const hr = host.rect;
      const hostArea = Math.max(1, hr.width * hr.height);
      for (const nr of nativeRects) {
        const ox = Math.max(0, Math.min(hr.right, nr.right) - Math.max(hr.left, nr.left));
        const oy = Math.max(0, Math.min(hr.bottom, nr.bottom) - Math.max(hr.top, nr.top));
        const ratio = (ox * oy) / hostArea;
        if (ratio > maxHostNativeOverlapRatio) maxHostNativeOverlapRatio = ratio;
      }
    }
    maxHostNativeOverlapRatio = Math.round(maxHostNativeOverlapRatio * 100) / 100;

    const clippedMatchingCount = matchingHostSamples.filter((host) => host.visible && (host.rect.width < 8 || host.rect.height < 8)).length;
    const matchingInsideHiddenAncestorCount = matchingHostSamples.filter((host) => host.zeroAncestor !== null).length;
    const roleTooltipVisibleCount = deepQueryAll('[role="tooltip"]').map(rectOf).filter(isVisibleRect).length;
    const missingRequiredHostAncestors = requiredHostAncestorSelectors.filter(
      (selector) =>
        !matchingHosts.some((host) => {
          try {
            return !!host.closest(selector);
          } catch {
            return false;
          }
        }),
    );

    return {
      url: location.href,
      title: document.title,
      bodyTextSample: bodyTextSample(),
      hostCount: hosts.length,
      visibleHostCount: hostSamples.filter((h) => h.visible).length,
      hiddenNativeCount: hiddenNativeEls.length,
      matchingHostCount: matchingHostSamples.length,
      visibleMatchingHostCount: matchingHostSamples.filter((h) => h.visible).length,
      anchorKeys,
      matchingAnchorKeys,
      hostSamples: hostSamples.slice(0, 8),
      hiddenNativeSamples: hiddenNativeSamples.slice(0, 8),
      nativeCount: nativeEls.length,
      visibleNativeCount: nativeRects.length,
      containerCount: containerEls.length,
      placementOk,
      placementReason,
      closestNativeDistance,
      missingRequiredHostAncestors,
      duplicateMatchingKeys,
      maxHostNativeOverlapRatio,
      clippedMatchingCount,
      matchingInsideHiddenAncestorCount,
      roleTooltipVisibleCount,
    };
  })()`);
}

export function debugEvidence(evidence: MountEvidence): string {
  return JSON.stringify(evidence, null, 2);
}
