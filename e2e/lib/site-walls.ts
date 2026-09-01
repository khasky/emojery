// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared handling of the shells live sites can serve instead of the requested
// page: gate URLs, Amazon's throttle interstitial, and the DOM-only dismissal of
// the sign-in prompts layered over public content. Every live-site consumer
// routes through here, and there are more of them than anyone remembers, so grep
// before editing the phrase sets.

import type { Page } from "@playwright/test";

// The final URL is a GATE page rather than the requested post. A gate URL skips
// even when a host mounted - the shell can render enough of the post to mount on
// while still displacing native placement. The regex is exported for the bridge
// suite, whose remote page can only be probed with a serialized source string
// (site-auth/harness.ts).
export const BLOCK_URL_RE = /\/sorry\/|\/accounts\/login|\/checkpoint\/|[?&]next=|[?&]js_challenge=|\bcaptcha\b|consent\.(?:google|youtube)\.com|\/login\b/i;
export function isBlockUrl(url: string): boolean {
  return BLOCK_URL_RE.test(url);
}

// EXACT sentences a known anti-bot wall renders - a deliberately DISJOINT set
// from INTERSTITIAL_PHRASES below: these appear ONLY on a wall, never in
// ordinary post content, so they are safe to match on ANY site with no mount
// evidence to disambiguate. Reddit serves two walls: a hard IP block ("You've
// been blocked by network security", what every CI runner gets) and the JS
// challenge ("Prove your humanity"); matched from the apostrophe-free tail so
// the phrase holds whichever quote codepoint the page serves.
export const WALL_SENTENCES_RE = /Click the button below to continue shopping|Enter the characters you see below|we just need to make sure you're not a robot|detected unusual traffic|verify you are (?:a )?human|blocked by network security|Prove your humanity/i;

// The one shared "this page is a wall, and here is why" verdict for suites that
// hold a live Page: the URL gate first, then the exact wall sentences. The text
// is matched through a LOCATOR, not `document.body.textContent`: Reddit renders
// its network-security wall inside an open shadow root, which textContent does
// not descend into - the read came back without the phrase and the selector-
// drift probe reported every Reddit selector as dead instead of skipping.
// Playwright's text engine pierces open shadow roots and normalizes whitespace
// itself, and it needs no page.evaluate, so a context destroyed by a wall's own
// reload can't silently blank the answer either.
export async function wallReason(page: Page): Promise<string | null> {
  if (isBlockUrl(page.url())) return `anti-bot wall URL: ${page.url()}`;
  const text = await page
    .getByText(WALL_SENTENCES_RE)
    .first()
    .textContent({ timeout: 2_000 })
    .catch(() => null);
  return text === null ? null : `anti-bot interstitial: "${text.replace(/\s+/g, " ").trim().slice(0, 160)}"`;
}

// Body-text phrases of an anti-bot / transient-error interstitial that no normal
// post page renders. Shared because the copies had already drifted apart
// (`rate.?limit` lived only in page-settle, `log in to|sign up to` only in
// theme-contrast); each caller composes ITS OWN extras through the builder below
// instead of editing this set, so a phrase added here reaches every caller.
// These are LOOSE phrases - safe only where mount evidence disambiguates; the
// wall sentences a bare page probe (selector-drift, the bridge suite) can trust
// are the EXACT set in WALL_SENTENCES_RE above. Keep the two disjoint.
// Plain lowercase literals, no regex metacharacters: a caller that cannot build a
// RegExp (a page.evaluate body) matches them with `includes` instead.
export const INTERSTITIAL_PHRASES = ["something went wrong", "please try again", "try again later", "temporarily unavailable", "too many requests"];

export function interstitialTextRe(...extraPhrases: string[]): RegExp {
  // Alternatives are module constants / suite fixtures, never input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  return new RegExp([...INTERSTITIAL_PHRASES, ...extraPhrases].join("|"), "i");
}

// Amazon serves an automated browser a throttle interstitial ("Click the button
// below to continue shopping") whose ONLY button navigates to the homepage, not
// back to the requested /dp/ product. Click it to clear the throttle, then
// re-open the product URL - the session now passes the check and the product
// page renders (the product URL is public, no sign-in involved). A genuine
// robot-check captcha carries no "Continue shopping" text and no /dp/ URL, so it
// still falls through to the caller's no-action-surface skip.
export async function clickAmazonContinueShopping(page: Page, productUrl: string): Promise<void> {
  if (!/amazon\./i.test(page.url())) return;
  // A SECOND, unrelated Amazon gate: the "Interest-Based Ads Notice" dialog,
  // whose own "Continue Shopping" button dismisses it in place (the product is
  // already loaded underneath). It renders none of the product markup, so a
  // caller checking selectors sees an empty page and reports the site as
  // changed. Scoped to a role=dialog: a healthy product page has no such
  // dialog, while its out-of-stock widget's bare "Continue Shopping" link is
  // not in one - so this can't click a working page off-product.
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /continue shopping/i })
    .first()
    .click({ timeout: 2_000 })
    .then(
      () => page.waitForTimeout(1_000),
      () => {},
    );
  // Match ONLY the throttle page's full sentence - a healthy product page (e.g.
  // amazon.ca) carries a bare "Continue Shopping" link in an out-of-stock widget,
  // so the short phrase alone false-fires and would click the page off-product.
  const onThrottle = await page.evaluate(() => /Click the button below to continue shopping/i.test((document.body?.textContent ?? "").replace(/\s+/g, " "))).catch(() => false);
  // A healthy product page with no throttle text: nothing to do. Never
  // re-navigate one - reloading healthy pages once tipped them into the wall.
  if (/\/(?:dp|gp)\//i.test(page.url()) && !onThrottle) return;

  if (onThrottle) {
    const button = page.getByRole("button", { name: /continue shopping/i }).first();
    const visible = await button.isVisible({ timeout: 1_500 }).catch(() => false);
    if (visible) {
      await button.click({ timeout: 5_000 }).catch(() => {});
    } else {
      await page.evaluate(() => {
        const candidates = Array.from(document.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="button"], a, [role="button"]'));
        const target = candidates.find((el) => {
          const label = (el.getAttribute("aria-label") || el.getAttribute("value") || el.textContent || "").replace(/\s+/g, " ").trim();
          return /^Continue shopping$/i.test(label);
        });
        target?.click();
      });
    }
    await page.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {});
    await page.waitForFunction(() => !/Click the button below to continue shopping/i.test(document.body?.textContent ?? ""), undefined, { timeout: 10_000 }).catch(() => {});
  }

  // "Continue shopping" (or a plain homepage bounce with no throttle text) leaves
  // us off the product; re-open it now the throttle is cleared.
  if (!/\/(?:dp|gp)\//i.test(page.url())) {
    await page.goto(productUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
    await page.waitForLoadState("load", { timeout: 45_000 }).catch(() => {});
  }
}

// Facebook's "See more from" wall and Instagram's signup modal are ONE shape: a
// visible dialog found by its text, closed by its own Close button, then a
// bounded wait for it to go. Fallback for a real click that times out on
// actionability while the modal animates in: a synthetic click on the dialog's
// labelled (else top-right) control. Only host/text/follow-up differ - hence a
// table rather than two near-copies.
interface DialogWall {
  /** Hostname suffix the wall belongs to; the probe is a no-op anywhere else. */
  hostSuffix: string;
  /** EVERY pattern must appear in a dialog's text for it to count as this wall. */
  detect: readonly string[];
  /** Narrower text that picks the wall out for the close click and the gone-wait -
   *  `detect` can include a generic "Log in" an ordinary page also renders. */
  match: string;
  /** Runs whether or not a wall was found (Facebook scrolls to the first post). */
  settle?: (page: Page) => Promise<void>;
}

const DIALOG_WALLS: Record<string, DialogWall> = {
  facebook: {
    hostSuffix: "facebook.com",
    detect: ["See more from", "Log In|Create new account"],
    match: "See more from",
    settle: scrollFacebookPageToFirstPost,
  },
  instagram: {
    hostSuffix: "instagram.com",
    detect: ["Never miss a post|Sign up for Instagram|Log in"],
    match: "Never miss a post|Sign up for Instagram",
  },
};

const DIALOG_SELECTOR = '[role="dialog"], [aria-modal="true"]';

export async function dismissDialogWall(page: Page, site: string): Promise<void> {
  const wall = DIALOG_WALLS[site];
  if (!wall) return;
  const detectInput = JSON.stringify({ hostSuffix: wall.hostSuffix, detect: wall.detect });
  const present = await page
    .evaluate<boolean>(`(() => {
      const { hostSuffix, detect } = ${detectInput};
      if (!location.hostname.endsWith(hostSuffix)) return false;
      // Patterns come from the DIALOG_WALLS table, never from input.
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const patterns = detect.map((source) => new RegExp(source, "i"));
      for (const dialog of document.querySelectorAll(${JSON.stringify(DIALOG_SELECTOR)})) {
        const rect = dialog.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        const text = (dialog.textContent ?? "").replace(/\\s+/g, " ");
        if (patterns.every((pattern) => pattern.test(text))) return true;
      }
      return false;
    })()`)
    .catch(() => false);
  if (!present) {
    await wall.settle?.(page);
    return;
  }

  const closeButton = page
    .locator(DIALOG_SELECTOR)
    // Pattern comes from the DIALOG_WALLS table, never from input.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    .filter({ hasText: new RegExp(wall.match, "i") })
    .getByRole("button", { name: /close/i })
    .first();
  const clicked = (await closeButton.isVisible({ timeout: 1_500 }).catch(() => false))
    ? await closeButton
        .click({ timeout: 5_000 })
        .then(() => true)
        .catch(() => false)
    : false;
  if (!clicked) await clickDialogCloseControl(page, wall.match);
  await waitForDialogGone(page, wall.match);
  await wall.settle?.(page);
}

// The wall's own close affordance, clicked in-page: its `aria-label`/`title`
// "close" control, else the right-most control along the dialog's top edge.
async function clickDialogCloseControl(page: Page, match: string): Promise<void> {
  await page
    .evaluate(`(() => {
      // Pattern comes from the DIALOG_WALLS table, never from input.
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const pattern = new RegExp(${JSON.stringify(match)}, "i");
      const dialog = Array.from(document.querySelectorAll(${JSON.stringify(DIALOG_SELECTOR)})).find((el) => pattern.test(el.textContent ?? ""));
      if (!dialog) return;
      const dialogRect = dialog.getBoundingClientRect();
      const controls = Array.from(dialog.querySelectorAll('button, [role="button"], [aria-label]')).filter((el) => {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const labelled = controls.find((el) => /close/i.test(el.getAttribute("aria-label") || el.getAttribute("title") || ""));
      // A dialog's dismiss control sits in its top edge band; anything lower is
      // page content that happens to be clickable.
      const topBandPx = 90;
      const topRight = controls
        .map((el) => ({ el, rect: el.getBoundingClientRect() }))
        .filter(({ rect }) => rect.top <= dialogRect.top + topBandPx)
        .sort((a, b) => b.rect.right - a.rect.right)[0]?.el;
      (labelled ?? topRight)?.click();
    })()`)
    .catch(() => {});
}

function waitForDialogGone(page: Page, match: string): Promise<void> {
  return page
    .waitForFunction(
      `(() => {
        // Pattern comes from the DIALOG_WALLS table, never from input.
        // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
        const pattern = new RegExp(${JSON.stringify(match)}, "i");
        return !Array.from(document.querySelectorAll(${JSON.stringify(DIALOG_SELECTOR)})).some((dialog) => {
          const rect = dialog.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && pattern.test(dialog.textContent ?? "");
        });
      })()`,
      undefined,
      { timeout: 10_000 },
    )
    .then(() => undefined)
    .catch(() => undefined);
}

async function scrollFacebookPageToFirstPost(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const host = location.hostname;
      if (host !== "facebook.com" && !host.endsWith(".facebook.com")) return;
      const existingHost = document.querySelector<HTMLElement>(".khasky-emojery-host");
      if (existingHost) {
        existingHost.scrollIntoView({
          block: "center",
          inline: "center",
          behavior: "auto",
        });
        return;
      }
      const articles = Array.from(document.querySelectorAll<HTMLElement>('[role="article"]'));
      const post =
        articles.find((article) => {
          const text = (article.textContent ?? "").replace(/\s+/g, " ");
          return /\bLike\b/i.test(text) && /\bComment\b/i.test(text);
        }) ?? articles[0];
      post?.scrollIntoView({ block: "center", inline: "center", behavior: "auto" });
    })
    .catch(() => {});
}

export async function dismissLoginWalls(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const fn = (window as typeof window & { __emojeryE2eUnwall?: () => void }).__emojeryE2eUnwall;
      fn?.();
    })
    .catch(() => {});
}

interface InterstitialOptions {
  /** Publish `window.__emojeryE2eUnwall` so a spec can re-run the sweep on
   *  demand (the supported-site suite calls it after every navigation/scroll). */
  exposeUnwallHook: boolean;
  /** Leave a dialog alone once it carries an Emojery host - the contrast
   *  suite measures the trigger inside such a dialog and must not hide it. */
  keepDialogsWithReactionHost: boolean;
}

// DOM-only dismissal of the sign-in prompts layered over public content (no
// login, no cookies), so the action row underneath is reachable. Runs as an init
// script, i.e. this function is stringified into the page: it must stay
// SELF-CONTAINED - no module-scope references, only its serialized `options`
// argument.
export function dismissInterstitialsInitScript(options: InterstitialOptions): void {
  const CLOSE_LABEL_RE = /^(close|dismiss|not now|maybe later|no thanks|skip|cancel)$/i;
  const WALL_TEXT_RE = /(log in|login|sign up|sign in|create account|join instagram|see more on|continue with|continue to|open app|use app)/i;

  const visibleRect = (el: Element): DOMRect | null => {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return rect;
  };

  const backgroundAlpha = (color: string): number => {
    const match = color.match(/^rgba?\((.+)\)$/i);
    if (!match) return 0;
    const parts = match[1]!.split(",").map((part) => part.trim());
    if (parts.length >= 4) {
      const alpha = Number(parts[3]);
      return Number.isFinite(alpha) ? alpha : 0;
    }
    return parts.length === 3 && parts.some((part) => Number(part) > 0) ? 1 : 0;
  };

  const isInsideLoginWall = (el: HTMLElement): boolean => {
    const modal = el.closest<HTMLElement>('[role="dialog"], [aria-modal="true"], [data-testid="sheetDialog"]');
    if (modal && WALL_TEXT_RE.test(modal.textContent || "")) return true;

    let node = el.parentElement;
    for (let depth = 0; depth < 6 && node && node !== document.body; depth++) {
      if (WALL_TEXT_RE.test(node.textContent || "")) return true;
      node = node.parentElement;
    }
    return false;
  };

  const clickCloseButtons = (): void => {
    const candidates = Array.from(document.querySelectorAll<HTMLElement>(["button", '[role="button"]', "[aria-label]", '[data-testid*="close" i]', '[data-testid*="dismiss" i]'].join(",")));
    for (const el of candidates) {
      const label = (el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "").replace(/\s+/g, " ").trim();
      if (!CLOSE_LABEL_RE.test(label)) continue;
      if (!isInsideLoginWall(el)) continue;
      if (!visibleRect(el)) continue;
      try {
        el.click();
      } catch {
        // Ignore detached/stale nodes.
      }
    }
  };

  const hideElement = (el: HTMLElement): void => {
    if (el.closest(".khasky-emojery-host, .khasky-emojery-overlay-host")) return;
    el.setAttribute("data-em-e2e-hidden", "1");
    el.style.setProperty("display", "none", "important");
    el.style.setProperty("visibility", "hidden", "important");
    el.style.setProperty("pointer-events", "none", "important");
  };

  const hideDialogs = (): void => {
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"], [aria-modal="true"], [data-testid="sheetDialog"]'))) {
      const rect = visibleRect(el);
      if (!rect) continue;
      if (options.keepDialogsWithReactionHost && el.querySelector(".khasky-emojery-host, .khasky-emojery-overlay-host")) continue;
      if (WALL_TEXT_RE.test(el.textContent || "")) {
        hideElement(el);
      }
    }
  };

  const hideFixedWalls = (): void => {
    // Carve-outs (both predate the recorded history - re-verify live before
    // narrowing): Reddit skips fixed/sticky hiding wholesale, and Threads' layout
    // roots below are spared by name - a viewport-covering fixed element there is
    // the page's own structure, and hiding it blanks the content this exists to reach.
    if (location.hostname === "reddit.com" || location.hostname.endsWith(".reddit.com")) {
      return;
    }
    for (const el of Array.from(document.body.querySelectorAll<HTMLElement>("*"))) {
      if (el.closest(".khasky-emojery-host, .khasky-emojery-overlay-host")) continue;
      if (el.id === "scrollview" || el.id === "barcelona-page-layout" || el.querySelector('[data-pagelet^="threads_"], #barcelona-page-layout')) {
        continue;
      }
      const cs = getComputedStyle(el);
      if (cs.position !== "fixed" && cs.position !== "sticky") continue;
      const rect = visibleRect(el);
      if (!rect) continue;
      const z = Number.parseInt(cs.zIndex || "0", 10);
      const coversViewport = rect.width >= window.innerWidth * 0.45 && rect.height >= window.innerHeight * 0.25;
      const coversMostViewport = rect.width >= window.innerWidth * 0.75 && rect.height >= window.innerHeight * 0.75;
      const backdropFilter = cs.backdropFilter || (cs as CSSStyleDeclaration & { webkitBackdropFilter?: string }).webkitBackdropFilter || "";
      const looksLikeBackdrop = coversMostViewport && (backgroundAlpha(cs.backgroundColor) > 0.15 || Number(cs.opacity || "1") < 0.98 || (backdropFilter !== "" && backdropFilter !== "none"));
      const looksLikeWall = WALL_TEXT_RE.test(el.textContent || "") || z >= 1000;
      if (coversViewport && (looksLikeWall || looksLikeBackdrop)) hideElement(el);
    }
  };

  const restoreScroll = (): void => {
    for (const el of [document.documentElement, document.body]) {
      el.style.setProperty("overflow", "auto", "important");
      el.style.setProperty("overflow-y", "auto", "important");
      el.style.setProperty("position", "static", "important");
      el.removeAttribute("inert");
      el.removeAttribute("aria-hidden");
    }
  };

  const run = (): void => {
    clickCloseButtons();
    hideDialogs();
    hideFixedWalls();
    restoreScroll();
  };

  if (options.exposeUnwallHook) {
    (window as typeof window & { __emojeryE2eUnwall?: () => void }).__emojeryE2eUnwall = run;
  }

  const start = (): void => {
    run();
    const observer = new MutationObserver(() => window.setTimeout(run, 50));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "aria-hidden", "inert"],
    });
    window.setInterval(run, 1_000);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
}
