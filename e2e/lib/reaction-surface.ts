// SPDX-License-Identifier: GPL-3.0-or-later
//
// The injected picker as seen from a live site page: open a surface that mounts
// one, read the trigger through its shadow root, react / un-react, and observe
// the public total settle. Written for the SINGLE-target surfaces the autonomous
// specs use (GitHub, GitLab), which is why several reads take "the first visible
// host" rather than a keyed one.
//
// The bigger live-site suites have their own, scenario-aware versions of this in
// `picker-probes.ts` + `page-settle.ts`; these are the plain ones.
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { isPageCrash } from "./auth-signin";
import { isFirefoxRun } from "./browser-session";
import { signIn } from "./extension-pages";
import { firstElementHandle, pollForValue } from "./picker-probes";
import { DEEP_QUERY_ALL_SRC, FIRST_VISIBLE_TRIGGER_SRC } from "./probe-src";
import { GRID_ITEM_SELECTOR, SEARCH_INPUT_SELECTOR, TRIGGER_SELECTOR } from "./selectors";
import { githubUrl, searchTermFor } from "./test-config";

// Open `url` and wait for an Emojery host to actually mount, retrying the
// nav so a transient blank/slow load self-heals. Login-free repo/project
// surfaces (GitHub/GitLab) mount the picker without any platform login - the
// safe reaction target for authed checks.
//
// Exhausting the retries THROWS by default, naming the URL and what the page
// last showed - returning a hostless page only moved the failure to a later,
// less readable assertion. Pass `requireHost: false` where a missing host is a
// site-side condition the caller handles itself (the coexistence surfaces and
// the GitLab legs, which skip rather than fail).
export async function openSite(context: BrowserContext, url: string, opts: { requireHost?: boolean } = {}): Promise<Page> {
  let page = await context.newPage();
  let lastHostState = "no attempt completed";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
      // Click-ready = visible box AND a trigger rendered in the shadow root.
      // Plain `querySelectorAll` on purpose: the host sits in the LIGHT DOM, and
      // a serialized typed callback cannot close over an interpolated source
      // helper anyway.
      const ready = await page
        .waitForFunction(
          () => {
            const hosts = Array.from(document.querySelectorAll<HTMLElement>(".khasky-emojery-host"));
            return hosts.some((h) => {
              const r = h.getBoundingClientRect();
              if (r.width <= 0 || r.height <= 0) return false;
              return h.shadowRoot?.querySelector("button.khasky-emojery-trigger, button.khasky-emojery-counter") != null;
            });
          },
          undefined,
          { timeout: 15_000 },
        )
        .then(
          () => true,
          (err: unknown) => {
            if (isPageCrash(err)) throw err;
            return false;
          },
        );
      if (ready) return page;
      lastHostState = await hostStateSummary(page);
    } catch (err) {
      // A headed-Chrome renderer crash ("Page crashed") under full-suite load
      // kills this tab mid-wait; reopen a fresh tab and retry rather than failing
      // the whole test on an environmental blip. Same self-heal as signIn.
      if (!isPageCrash(err)) throw err;
      lastHostState = "page crashed";
      await page.close().catch(() => {});
      page = await context.newPage();
    }
  }
  if (opts.requireHost === false) return page;
  // Left open on purpose: the session teardown closes it, and Playwright's
  // failure screenshot then still captures what the page was showing.
  throw new Error(`No click-ready Emojery host on ${url} after 3 attempts (last seen: ${lastHostState}).`);
}

// Same light-DOM reasoning as the wait above: a plain query in a typed callback.
async function hostStateSummary(page: Page): Promise<string> {
  return page
    .evaluate(() => {
      const hosts = Array.from(document.querySelectorAll<HTMLElement>(".khasky-emojery-host"));
      const sized = hosts.filter((host) => {
        const rect = host.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const withTrigger = sized.filter((host) => host.shadowRoot?.querySelector("button.khasky-emojery-trigger, button.khasky-emojery-counter") != null);
      return `url=${location.href} hosts=${hosts.length} sized=${sized.length} withTrigger=${withTrigger.length}`;
    })
    .catch((err: unknown) => `page unreadable (${String(err).slice(0, 120)})`);
}

export async function openGithub(context: BrowserContext): Promise<Page> {
  return openSite(context, githubUrl());
}

// The arrangement every signed-in reaction case shares. The mount assertion belongs in
// here: without a host there is nothing for the case to act on, so a missing one is a
// broken arrangement rather than the thing under test. Pass `email` for the cases that
// pick their own account; the rest take the configured default.
export async function signedInGithubPage(context: BrowserContext, email?: string): Promise<Page> {
  await signIn(context, email);
  const page = await openGithub(context);
  expect(await firstMountedKey(page), "a GitHub Emojery host should mount").not.toBeNull();
  return page;
}

// First mounted target key matching a site prefix (default GitHub). The
// `[data-khasky-emojery-mounted]` anchor is the source of truth (see site-auth/probes.ts
// MountEvidence.mountKeys for why anchors, not hosts, own identity).
export async function firstMountedKey(page: Page, sitePrefix = "github:"): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    const prefix = ${JSON.stringify(sitePrefix)};
    ${DEEP_QUERY_ALL_SRC}
    for (const a of deepQueryAll("[data-khasky-emojery-mounted]")) {
      if (!a.isConnected) continue;
      const key = a.getAttribute("data-khasky-emojery-mounted");
      if (key?.startsWith(prefix)) return key;
    }
    return null;
  })()`);
}

interface CounterReading {
  /** Visible counter text, e.g. "🔥1" - empty when the trigger has no count. */
  text: string;
  /** Aggregate total parsed from the trigger aria-label ("N reactions — ..."). */
  total: number | null;
  isCounter: boolean;
}

// Read the page's (single) reaction trigger. Reads the first visible host, NOT a
// key-matched one (see hasOwnReaction for why).
export async function readCounter(page: Page): Promise<CounterReading> {
  return page.evaluate<CounterReading>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    ${FIRST_VISIBLE_TRIGGER_SRC}
    const found = firstVisibleTrigger();
    if (!found) return { text: "", isCounter: false, total: null };
    const trigger = found.trigger;
    const text = (trigger.textContent || "").replace(/\\s+/g, " ").trim();
    const isCounter = trigger.classList.contains("khasky-emojery-counter");
    const label = trigger.getAttribute("aria-label") || "";
    const m = label.match(/(\\d+)/);
    return { text, isCounter, total: m ? Number(m[1]) : null };
  })()`);
}

// The trigger renders its plain form until the count fetch resolves, so a read
// taken right after mount/reload reports null for a target that in fact carries
// reactions. Poll for a parseable count; null after the grace = no counter
// rendered at all (0 reactions). Both total readers below share this window, so
// the grace changes in one place.
const COUNTER_GRACE_MS = 5_000;

function pollCounterTotal(page: Page, graceMs: number): Promise<number | null> {
  return pollForValue(
    async () => (await readCounter(page)).total,
    (total) => total !== null,
    graceMs,
    250,
  );
}

// The aggregate a counter delta starts from. A premature null read is
// indistinguishable from a genuine zero, and a baseline of 0 then makes every
// later delta off by the real total - so only a target that stays uncounted
// through the grace is the 0 it reads as.
export async function readSettledTotal(page: Page, graceMs = COUNTER_GRACE_MS): Promise<number> {
  return (await pollCounterTotal(page, graceMs)) ?? 0;
}

// Drop the extension's read-through counts cache (`cache:` keys, TTL
// READ_CACHE_TTL_MS = 60s, defined in src/shared/config.ts and applied by
// src/shared/counts-cache.ts) as the extension does on sign-in/out. Without it a
// reload is NOT a refetch - loadInitial renders a cache hit, so two
// "consecutive" settle reads can be one stale snapshot.
//
// Chromium clears it in the service worker. Firefox has NO reachable extension
// context at all (no service worker, and juggler cannot open extension pages),
// so this is a no-op there - acceptable because every caller sits behind
// signIn(), which is itself chromium-only.
async function clearCountsCache(page: Page): Promise<void> {
  const context = page.context();
  if (isFirefoxRun()) return;
  const worker = context.serviceWorkers()[0];
  if (!worker) return;
  await worker
    .evaluate(async () => {
      const { chrome } = globalThis as unknown as {
        chrome: {
          storage: {
            local: {
              get: (keys: null) => Promise<Record<string, unknown>>;
              remove: (keys: string[]) => Promise<void>;
            };
          };
        };
      };
      const keys = Object.keys(await chrome.storage.local.get(null)).filter((key) => key.startsWith("cache:"));
      if (keys.length > 0) await chrome.storage.local.remove(keys);
    })
    .catch(() => {});
}

// Reload and read the PUBLIC aggregate total off the rendered counter (shadow
// DOM via `readCounter`) - the VISUAL way to observe a server-confirmed count,
// no direct API read. Drops the local counts cache first so the reload really
// re-fetches through the SW; returns null when no counter is shown (0 reactions).
export async function reloadAndReadTotal(page: Page): Promise<number | null> {
  await clearCountsCache(page);
  await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await visibleHostCount(page).catch(() => 0)) > 0) break;
    await page.waitForTimeout(750);
  }
  // Null after the grace is passed through, not flattened to 0: waitForSettledTotal
  // treats it as 0 and re-reads, while a caller polling for a change must see it.
  return pollCounterTotal(page, COUNTER_GRACE_MS);
}

// Reload-read the public total until it stops changing (two equal consecutive
// reads) or the timeout elapses. A single read right after load is stale, and
// asserting an absolute count off that baseline flakes (seen live: the baseline
// read one low, so `before+1` never matched the settled total) - a stability
// window is the reliable "settled" signal.
export async function waitForSettledTotal(page: Page, opts: { timeout?: number; interval?: number } = {}): Promise<number> {
  const timeout = opts.timeout ?? 90_000;
  const interval = opts.interval ?? 10_000;
  const deadline = Date.now() + timeout;
  let prev = (await reloadAndReadTotal(page)) ?? 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(interval);
    const next = (await reloadAndReadTotal(page)) ?? 0;
    if (next === prev) return next;
    prev = next;
  }
  return prev;
}

// Whether the signed-in user has an own reaction on the page's (single) target, via the stable
// `data-active="true"` marker - sprite-proof, unlike a textContent read. NOT key-scoped: it
// reads the first VISIBLE host, because a host can land in a different DOM node than its keyed
// anchor (see site-auth/probes.ts MountEvidence.mountKeys) - fine on the single-target pages
// the authed specs use.
export async function hasOwnReaction(page: Page): Promise<boolean> {
  return page.evaluate<boolean>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    ${FIRST_VISIBLE_TRIGGER_SRC}
    return firstVisibleTrigger()?.trigger.getAttribute("data-active") === "true";
  })()`);
}

// The single-target twin of picker-probes.ts's findVisibleEmojiGridOption, and it uses the
// looser `width > 0` rather than that one's full isVisibleRect on purpose: these specs open
// the picker on a login-free repo page where the grid is the only thing on screen, so the
// off-viewport and clipped cases isVisibleRect exists for cannot arise, and the stricter
// read only adds a way for a correctly rendered option to go unfound. Keep them separate.
async function findEmojiOption(page: Page, emoji: string) {
  return firstElementHandle(
    page,
    `(() => {
    const expected = ${JSON.stringify(emoji)};
    ${DEEP_QUERY_ALL_SRC}
    return deepQueryAll(".khasky-emojery-grid-item").find((el) => (el.textContent ?? "").trim() === expected && el.getBoundingClientRect().width > 0) ?? null;
  })()`,
  );
}

// findEmojiOption, polled to a deadline. The picker's search is debounced, so a
// single read taken right after the fill can still see the pre-search grid under
// load and report a working extension as "the picker has no such option" - the
// same race lib/picker-probes.ts solves in expectVisibleEmojiGridOption.
function waitForEmojiOption(page: Page, emoji: string, timeoutMs = 15_000) {
  return pollForValue(
    () => findEmojiOption(page, emoji),
    (option) => option !== null,
    timeoutMs,
    250,
  );
}

// Open the picker tray via the KEYBOARD, never a coordinate click. The trigger
// keeps re-measuring for up to ~10s after mount (GLYPH_REMEASURE_UNTIL_MS in
// src/ui/mount.ts scheduleStyleReblend) and the deferred count fetch then swaps
// it to the wider counter form, so a click aimed at the pre-settle box lands
// beside the button and the grid "never appears" (verified live: 3 of 6 runs,
// zero click handlers reached). Focus + Space is coordinate-free and the same
// trusted path a keyboard user takes; mouse-click opening stays covered by
// picker.browser.test.tsx.
export async function openPickerTray(page: Page): Promise<void> {
  const trigger = page.locator(TRIGGER_SELECTOR).filter({ visible: true }).first();
  await trigger.focus({ timeout: 8_000 });
  await page.keyboard.press(" ");
}

// React with a SPECIFIC emoji: open the picker, search to surface it, click the
// option ONLY if it isn't already selected (clicking a selected option toggles
// the reaction OFF). Normal click, NOT force, so the tall scrollable popover
// scrolls the option into view first.
export async function reactWith(page: Page, emoji: string): Promise<void> {
  await openPickerTray(page);
  await expect(page.locator(GRID_ITEM_SELECTOR).filter({ visible: true }).first()).toBeVisible({ timeout: 8_000 });
  await page.locator(SEARCH_INPUT_SELECTOR).filter({ visible: true }).first().fill(searchTermFor(emoji));
  const option = await waitForEmojiOption(page, emoji);
  expect(option, `picker should expose the ${emoji} option`).not.toBeNull();
  if (option) {
    const checked = await option.getAttribute("aria-pressed").catch(() => null);
    if (checked !== "true") await option.click({ timeout: 10_000 });
    await option.dispose().catch(() => {});
  }
  // The pick is optimistic in the page and durable only after the worker answers; Escape
  // any sooner tears the picker down mid-write and the counter read below races it.
  await page.waitForTimeout(700);
  await page.keyboard.press("Escape").catch(() => {});
}

// Black-box proof that a queued vote reached the server: resolve once the NEXT
// vote POST completes on the wire (any response settles the queue entry). Call
// BEFORE the reaction click - the flush is async and a watcher installed
// afterwards can miss an already-finished request and hang. Await the returned
// thunk wherever a sign-out or profile teardown would drop a still-queued vote:
// a fixed sleep lost that race live (the close cancelled the POST mid-flight).
export function watchNextVoteFlush(context: BrowserContext, timeoutMs = 60_000): () => Promise<void> {
  const flushed = context.waitForEvent("response", { predicate: (response) => response.url().includes("/reactions/vote"), timeout: timeoutMs }).then(
    () => true,
    () => false,
  );
  return async () => {
    expect(await flushed, "the queued vote should flush to the server before teardown").toBe(true);
  };
}

// Toggle OFF whatever reaction is currently selected, so a test starts a
// counter delta from a known "no own reaction" baseline. Returns whether a
// selected reaction was actually cleared (false = nothing was selected), so
// callers know if an un-react vote is now in the queue.
export async function clearReaction(page: Page): Promise<boolean> {
  // Two passes, because `mine` arrives with the counts fetch: a tray opened
  // right after mount can still render an unpressed grid while the reaction is
  // about to show up, and `count()` takes that instant read at face value - the
  // pass then clears nothing and the caller polls a reaction that never goes
  // away (seen live: 30 s of `hasOwnReaction` true after a "successful" clear).
  // The second pass reopens the tray only when the trigger is still active.
  let hadSelection = false;
  for (let pass = 0; pass < 2; pass++) {
    await openPickerTray(page);
    const checked = page.locator(`${GRID_ITEM_SELECTOR}[aria-pressed="true"]`).filter({ visible: true });
    if ((await checked.count()) > 0) {
      hadSelection = true;
      await checked.first().click({ timeout: 10_000 });
      // Un-reacting is the same optimistic-then-durable round trip as the pick above; the
      // next `checked.count()` must not read the grid mid-update.
      await page.waitForTimeout(600);
    }
    await page.keyboard.press("Escape").catch(() => {});
    // The optimistic clear lands only after the content script's round-trip to
    // the service worker, so give it a moment before calling the pass wasted.
    if (!(await stillActiveAfter(page, 3_000))) break;
  }
  return hadSelection;
}

function stillActiveAfter(page: Page, timeoutMs: number): Promise<boolean> {
  return pollForValue(
    () => hasOwnReaction(page),
    (active) => !active,
    timeoutMs,
    250,
  );
}

export async function visibleHostCount(page: Page): Promise<number> {
  return page.evaluate<number>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    return deepQueryAll(".khasky-emojery-host").filter((h) => {
      const r = h.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }).length;
  })()`);
}

// Native site controls currently hidden for replace-native
// (`data-khasky-emojery-hidden="1"`). The marker sits on the SITE's own
// control in the light DOM, so a plain query is enough.
export async function hiddenNativeCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll('[data-khasky-emojery-hidden="1"]').length);
}

// Whether the picker marks `emoji` as the user's selected reaction. Side effect:
// opens the picker (searching to surface the option) and closes it again.
export async function isReactionChecked(page: Page, emoji: string): Promise<boolean> {
  await openPickerTray(page);
  await expect(page.locator(GRID_ITEM_SELECTOR).filter({ visible: true }).first()).toBeVisible({ timeout: 8_000 });
  await page.locator(SEARCH_INPUT_SELECTOR).filter({ visible: true }).first().fill(searchTermFor(emoji));
  // Wait for the debounced grid to actually render the option before reading its
  // pressed state: a fixed sleep can read an un-rendered grid, which is
  // indistinguishable from a genuinely unselected reaction.
  const option = await waitForEmojiOption(page, emoji);
  const checked = (await option?.getAttribute("aria-pressed").catch(() => null)) === "true";
  await option?.dispose().catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  return checked;
}

// Open the picker and return the popover's viewport-relative rect plus the
// viewport size, for the layout (zoom / narrow-screen) checks. Measures
// EVERYTHING in-page in one evaluate so the rect and the viewport share the same
// coordinate space even under CSS zoom; pierces the open shadow root. Returns
// null if the popover never opens.
export async function openPickerViewportFit(page: Page): Promise<{
  rect: { left: number; top: number; right: number; bottom: number };
  vw: number;
  vh: number;
} | null> {
  // Keyboard, not mouse: under CSS `zoom` the browser's hit testing and
  // Playwright's click-coordinate mapping disagree, so a click can miss the
  // trigger and never open the tray. openPickerTray is exactly that ritual.
  await openPickerTray(page);
  return page.evaluate<{
    rect: { left: number; top: number; right: number; bottom: number };
    vw: number;
    vh: number;
  } | null>(`(async () => {
    ${DEEP_QUERY_ALL_SRC}
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const pop = deepQueryAll(".khasky-emojery-popover").find((el) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
      });
      if (pop) {
        const r = pop.getBoundingClientRect();
        // Under CSS zoom, getBoundingClientRect is in the SCALED coordinate space while
        // window.innerWidth stays the layout viewport - apples to oranges. Normalize the rect
        // back to CSS pixels by the zoom factor (a no-op at zoom 1).
        const rawZoom = getComputedStyle(document.documentElement).zoom;
        const zoom = rawZoom && rawZoom !== "normal" ? parseFloat(rawZoom) || 1 : 1;
        return {
          rect: {
            left: r.left / zoom,
            top: r.top / zoom,
            right: r.right / zoom,
            bottom: r.bottom / zoom,
          },
          vw: window.innerWidth,
          vh: window.innerHeight,
        };
      }
      await new Promise((res) => setTimeout(res, 100));
    }
    return null;
  })()`);
}
