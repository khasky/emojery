// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared gating + high-level black-box operations for the site-authenticated
// bridge suite. Everything here reads only user-perceivable signals.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_LABELS } from "../../src/shared/sites";
import { GRID_ITEM_SELECTOR, SEARCH_INPUT_SELECTOR, TRIGGER_SELECTOR } from "../lib/selectors";
import { BLOCK_URL_RE, WALL_SENTENCES_RE } from "../lib/site-walls";
import { SUPPORTED_SITE_SCENARIOS } from "../supported-sites";
import { type Bridge, connectBridge, isBridgeError } from "./bridge";
import { evidenceProbe, type MountEvidence, type PickerState, pickerStateProbe } from "./probes";
import { authContentUrl, type SiteId } from "./scenarios";

export { GRID_ITEM_SELECTOR, TRIGGER_SELECTOR };

const truthy = (v: string | undefined): boolean => !!v && v !== "0" && v.toLowerCase() !== "false";

// The suite only runs when explicitly enabled AND a way to reach the bridge is
// configured (extension token for the in-process server, or an external URL).
export function siteAuthEnabled(): boolean {
  if (!truthy(process.env.E2E_SITEAUTH)) return false;
  return !!process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN || !!process.env.E2E_MCP_URL;
}

const STAGING_BUILD_DIR = ".output/chrome-mv3-staging";
const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

// Read from the same env var the rest of the suite uses. Null when it is unset or
// unparsable, which leaves the comparison below nothing to compare against.
function targetApiOrigin(): string | null {
  const raw = process.env.E2E_API_BASE?.trim() || process.env.WXT_API_BASE?.trim();
  if (!raw) return null;
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

// Raised when the local build output itself is wrong (see stagingBuildProblem).
const WRONG_BUILD_HINT = `The Chrome under test must run ${STAGING_BUILD_DIR}, listed as "Emojery (Staging)" on chrome://extensions - this suite is written against that build.`;

// Which build the user's Chrome loaded is invisible from a content page, since the
// bridge cannot reach chrome-extension:// pages. So the gate is the one thing visible
// locally: whether a staging build exists at all. Null when the build is fine.
function stagingBuildProblem(): string | null {
  const manifestPath = resolve(extensionRoot, STAGING_BUILD_DIR, "manifest.json");
  if (!existsSync(manifestPath)) {
    return `No staging build at ${STAGING_BUILD_DIR} - nothing to load in Chrome. Run "pnpm run build:staging", load it unpacked, then re-run.`;
  }
  const apiOrigin = targetApiOrigin();
  if (!apiOrigin) {
    return `E2E_API_BASE is unset, so ${STAGING_BUILD_DIR} cannot be checked against the backend this run targets - set it in .env.e2e (see .env.e2e.example) and re-run.`;
  }
  const hosts = (JSON.parse(readFileSync(manifestPath, "utf8")) as { host_permissions?: string[] }).host_permissions ?? [];
  if (!hosts.some((host) => host.startsWith(apiOrigin))) {
    return `${STAGING_BUILD_DIR} targets a different backend than ${apiOrigin} (stale or production output in that folder) - rebuild it with "pnpm run build:staging" and reload the extension in Chrome.`;
  }
  return null;
}

// Failing here is FATAL for the run - the suite never skips. The underlying error
// rides along as the cause, so a stale token, a Chrome that isn't running and a failed
// @playwright/mcp import stay distinguishable.
async function tryConnect(): Promise<Bridge> {
  try {
    return await connectBridge();
  } catch (err) {
    throw new Error("Site-auth bridge could not connect. Start Chrome with the Playwright Extension running and set a CURRENT PLAYWRIGHT_MCP_EXTENSION_TOKEN (copy it from the extension popup). See e2e/site-auth/README.md.", { cause: err });
  }
}

// Real Chrome has user tabs. A throwaway shows a single about:blank. This says nothing
// about whether the current tab is an ordinary one: with nothing selected in the
// Playwright Extension the relay hands over its own connect.html page, and the first
// goto legitimately navigates that tab onto the site (bridge.ts closes it on teardown).
async function attachedToRealBrowser(bridge: Bridge): Promise<boolean> {
  const urls = await bridge.tabUrls().catch(() => [] as string[]);
  if (urls.length === 0) return false;
  if (urls.length === 1 && urls[0] === "about:blank") return false;
  return true;
}

export function mountKeyPattern(site: SiteId): string {
  // Union of the site's scenario patterns from the shared registry. Only reddit's
  // are uniformly tight - every other site has at least one scenario using a bare
  // '^site:', so the union comes out as that. Tighten the registry to tighten this.
  const patterns = SUPPORTED_SITE_SCENARIOS.filter((s) => s.site === site).map((s) => s.mountKeyPattern);
  return patterns.length > 0 ? patterns.map((p) => `(?:${p})`).join("|") : `^${site}:`;
}

// So a video page doesn't blast audio while the suite runs. No-op elsewhere.
export async function muteMedia(bridge: Bridge): Promise<void> {
  await bridge.act(`await page.evaluate(() => { for (const v of document.querySelectorAll('video, audio')) { try { v.pause(); v.muted = true; } catch {} } }).catch(() => {});`).catch(() => {});
}

// Dismiss known full-screen interstitials that block scroll/clicks. Currently only
// X's "Review your email" modal, closed via "Yes, that's correct" - a benign
// confirmation that leaves the account unchanged. The label is X-specific, so this is
// a no-op elsewhere. Bridge-side source so it can ride inside another call's body.
const DISMISS_BLOCKING_DIALOGS_SRC = `const names = [${JSON.stringify("Yes, that's correct")}];
       for (const n of names) {
         const btn = page.getByRole('button', { name: n });
         if ((await btn.count().catch(() => 0)) > 0) {
           const first = btn.first();
           if (await first.isVisible().catch(() => false)) {
             await first.click({ timeout: 3000 }).catch(() => {});
             // The dialog animates out; the next count() must not see it mid-teardown.
             await page.waitForTimeout(400);
           }
         }
       }`;

// Every helper here that clicks or reads sweeps first, so a test never has to.
async function dismissBlockingDialogs(bridge: Bridge): Promise<void> {
  await bridge.act(DISMISS_BLOCKING_DIALOGS_SRC).catch(() => {});
}

// Condition-first settle: what every caller polls for next is a painted host, so
// stop waiting the moment one appears. settleMs is only the CEILING - a page that
// never mounts (wall, disabled site, a row below the fold) pays it in full. The host
// is light DOM, so a plain query reaches it. The round-trip itself is the floor.
const HOST_PAINTED = `return Array.from(document.querySelectorAll('.khasky-emojery-host')).some((h) => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; });`;

// A site redirects within its own host (login hops, canonical paths, an SPA
// rewriting the path) and none of that means the navigation missed. A DIFFERENT host
// - or about:blank - does.
function landedOnTarget(landed: string, wanted: string): boolean {
  try {
    const host = (u: string) => new URL(u).hostname.replace(/^www\./, "");
    return host(landed) === host(wanted);
  } catch {
    return false;
  }
}

export async function gotoSettled(bridge: Bridge, url: string, settleMs = 3500): Promise<void> {
  await bridge.goto(url);
  await bridge.waitFor(HOST_PAINTED, settleMs);
  // bridge.goto swallows its own failure by design, so a navigation that never
  // committed leaves the bridge measuring the PREVIOUS page - or the blank tab it
  // opened to work in, which reads perfectly and has no Emojery in it. Every later
  // read then looks like "this site mounted nothing". One ~8ms read per navigation.
  const landed = await bridge.run<string>(`return page.url();`).catch(() => null);
  if (landed !== null && !landedOnTarget(landed, url)) {
    await bridge.goto(url);
    await bridge.waitFor(HOST_PAINTED, settleMs);
  }
  await dismissBlockingDialogs(bridge);
  await muteMedia(bridge);
}

export async function readEvidence(bridge: Bridge, site: SiteId): Promise<MountEvidence> {
  return bridge.evaluate<MountEvidence>(evidenceProbe(mountKeyPattern(site)));
}

// The bridge twin of site-walls.ts wallReason, as serialized source because the
// bridge executes source strings: BLOCK_URL_RE on the final URL, then
// WALL_SENTENCES_RE through a locator, which must pierce the open shadow root Reddit
// renders its network-security wall into. Any bridge failure reads as "no wall
// seen": this probe only upgrades a zero-host diagnosis, never invents one.
async function bridgeWallReason(bridge: Bridge): Promise<string | null> {
  try {
    return await bridge.run<string | null>(
      `const url = page.url();
       if (new RegExp(${JSON.stringify(BLOCK_URL_RE.source)}, 'i').test(url)) return 'anti-bot wall URL: ' + url;
       const text = await page.getByText(new RegExp(${JSON.stringify(WALL_SENTENCES_RE.source)}, 'i')).first().textContent({ timeout: 2000 }).catch(() => null);
       return text === null ? null : 'anti-bot interstitial: "' + text.replace(/\\s+/g, ' ').trim().slice(0, 160) + '"';`,
    );
  } catch {
    return null;
  }
}

// Emojery runs NO scan while document.hidden and catches up on the next
// visibilitychange (src/adapters/scan-observer.ts), so a tab that is not the ACTIVE one
// in its window mounts nothing at all - on every site at once. Measured through this
// bridge: a foreground tab reads 1 host / 1 anchor on the same URL where the same tab,
// backgrounded and reloaded, reads 0 / 0, and comes back within a beat of being
// activated. That is exactly the shape of a whole file failing "log into <site>" on
// every site while the run's other files pass, so it must never be diagnosed as a login.
//
// bridge.goto/reload activate the tab, so this catches a tab backgrounded AFTER the
// navigation. What does that, measured on Windows 10 / Chrome 152: minimizing the
// window, clicking another tab in it, or - unless Chrome was started with
// --disable-backgrounding-occluded-windows - another window fully covering it. Losing
// focus alone leaves the tab visible. The observation is void either way, and the tab
// is re-activated so the retry starts clean.
async function backgroundedTabFault(bridge: Bridge, site: SiteId): Promise<Error | null> {
  const hidden = await bridge.evaluate<boolean>("return document.hidden === true;").catch(() => null);
  if (hidden !== true) return null;
  await bridge.focusTab().catch(() => {});
  return new Error(
    `${site}: the driven tab was in the BACKGROUND while this check ran, so Emojery scanned nothing - a hidden tab mounts no picker on any site. Don't minimize that Chrome window and don't click another tab in it; covering it is fine once Chrome runs with --disable-backgrounding-occluded-windows (see e2e/site-auth/README.md). This is NOT a missing ${site} login; the tab has been re-activated, so a re-run measures the real page.`,
  );
}

// A recognized wall is an ENVIRONMENT failure. The walls hit this suite's real,
// signed-in Chrome too - Reddit served both its network-security block and its "Prove
// your humanity" reCAPTCHA on this suite's own fixture URLs - so without this verdict
// every zero-host test failed with "log into <site>" at an account that was signed in.
function wallFailure(site: SiteId, wall: string): Error {
  return new Error(`${site}: the page served an anti-bot / login wall instead of the content - ${wall}. Solve or dismiss the challenge in the connected Chrome, then re-run. This is NOT a missing ${site} login.`);
}

// The message every "did the picker mount on this surface?" assert fails with. A
// caller with more to say appends its own sentence. The brand name comes from the
// registry, so it reads "GitLab" with the brand's own capitalization.
export function noHostMounted(site: SiteId, extra?: string): string {
  return `${site}: no Emojery host mounted - log into ${SITE_LABELS[site]} in the connected Chrome.${extra ? ` ${extra}` : ""}`;
}

// What the probe was looking at when it saw nothing. A zero-host verdict names a
// login by default, which is worth nothing once the same verdict lands on site after
// site: the URL and the anchor count say whether the bridge was on the page the
// test meant, and whether the content script ran at all.
export async function zeroHostEvidence(bridge: Bridge, site: SiteId): Promise<string> {
  const ev = await readEvidence(bridge, site).catch(() => null);
  if (!ev) return "The bridge could not re-read the page for a diagnosis.";
  return `The bridge was looking at ${ev.url} with ${ev.mountKeys.length} Emojery anchor(s) on it - no anchors at all means the content script did not run there.`;
}

// page.mouse.wheel resolves only once the RENDERER acknowledges the input event and
// takes no timeout, so a feed whose main thread is busy holds the call until the
// bridge's own ceiling: measured on the facebook feed at 61s, twice, where a scripted
// scroll in the same place returned in under 4s. The wheel stays the instrument -
// site wheel handlers and inner scroll containers need it - but a blocked renderer
// costs a few seconds against that measured 61s, and the queued event still lands.
const WHEEL_ACK_BUDGET_MS = 4_000;

// Stops WAITING on bodySrc past the budget without stopping the work: a queued wheel
// still lands, an evaluate still finishes. page.waitForTimeout is a Node-side sleep
// in Playwright, so it fires while the renderer is wedged.
function boundedSrc(bodySrc: string, budgetMs: number = WHEEL_ACK_BUDGET_MS): string {
  return `{ const __bounded = (async () => { ${bodySrc} })(); __bounded.catch(() => {}); await Promise.race([__bounded, page.waitForTimeout(${budgetMs})]); }`;
}

export function wheelBySrc(deltaExpr: string): string {
  return boundedSrc(`await page.mouse.wheel(0, ${deltaExpr});`);
}

// Re-reads evidence each step, covering virtualization and lazy IntersectionObserver
// mounting. Zero hosts across every step with a recognized wall on screen throws the
// wall verdict, so the caller's "log into <site>" assert never fires.
export async function scrollAndCountHosts(bridge: Bridge, site: SiteId, steps: number): Promise<{ maxVisible: number; sawDuplicate: boolean }> {
  let maxVisible = 0;
  let sawDuplicate = false;
  let failedReads = 0;
  let consecutiveFails = 0;
  let lastError: unknown = null;
  for (let i = 0; i < steps; i++) {
    // One lost read must not kill a multi-step walk. Only a BRIDGE failure is
    // tolerated: a probe that threw in the page is this suite's bug and goes up.
    const ev = await readEvidence(bridge, site).catch((err: unknown) => {
      if (!isBridgeError(err)) throw err;
      failedReads += 1;
      consecutiveFails += 1;
      lastError = err;
      return null;
    });
    if (!ev) {
      // TWO lost reads in a row means the relay is dead. Walking the remaining steps
      // costs ~61s each (20 of them on the deep sites) and still reports whatever the
      // surviving steps saw, which is a green test on a page nobody was watching.
      if (consecutiveFails >= 2) throw bridgeReadFailure(site, failedReads, i + 1, lastError);
      // Don't scroll on a lost step, so the next read re-tries the same viewport and
      // the walk observes every screen.
      continue;
    }
    consecutiveFails = 0;
    maxVisible = Math.max(maxVisible, ev.visibleHostCount);
    // Confirm a duplicate persists before counting it: a re-render can briefly leave
    // two anchors on one key mid-mutation, which would otherwise flake.
    if (ev.duplicateKeys.length > 0) {
      await bridge.waitMs(1200);
      const recheck = await readEvidence(bridge, site);
      if (recheck.duplicateKeys.length > 0) sawDuplicate = true;
    }
    // Wheel, settle and the blocking-dialog sweep (a modal can pop mid-scroll) in ONE
    // bridge call: a round-trip costs ~0.7s and this loop runs up to 20 times per
    // site. The sweep rides at the END of a step, so every evidence read above still
    // follows one - gotoSettled sweeps before the first.
    //
    // A step that cannot scroll is the BRIDGE failing, exactly like a lost read. It
    // used to be the one call here nobody caught, so a stall left the walk as a bare
    // McpError with no site in it.
    const scrolled = await bridge.act(`${wheelBySrc("Math.round(page.viewportSize()?.height * 0.7 || 600)")} await page.waitForTimeout(900); ${DISMISS_BLOCKING_DIALOGS_SRC}`).then(
      () => true,
      (err: unknown) => {
        failedReads += 1;
        consecutiveFails += 1;
        lastError = err;
        return false;
      },
    );
    if (!scrolled && consecutiveFails >= 2) throw bridgeReadFailure(site, failedReads, i + 1, lastError);
  }
  if (maxVisible < 1) {
    const backgrounded = await backgroundedTabFault(bridge, site);
    if (backgrounded) throw backgrounded;
    const wall = await bridgeWallReason(bridge);
    if (wall) throw wallFailure(site, wall);
  }
  return { maxVisible, sawDuplicate };
}

// A read that THROWS means a dead tab, a crashed page or a bridge -32001 that survived
// its retry. Reporting 0 for any of those turns a broken connection into
// "log into <site>".
function bridgeReadFailure(site: SiteId, failedReads: number, reads: number, cause: unknown): Error {
  return new Error(`Site-auth bridge could not read the page (${failedReads}/${reads} probes failed) - this is a bridge/tab failure, NOT a missing ${site} login. Check the connected Chrome and the Playwright Extension token.`, { cause });
}

// A logged-in permalink hydrates far later than a feed: on a Facebook /posts/
// permalink the action row mounted ~45s after the navigation committed. Feeds keep
// the shorter default in waitForHost. Tests that spend this need PERMALINK_TEST_TIMEOUT_MS,
// since one of them crosses such a page twice.
export const PERMALINK_HOST_WAIT_MS = 60_000;
export const PERMALINK_TEST_TIMEOUT_MS = 240_000;

// One bounded sweep of the nudge below: NUDGE_DOWN_STEPS wheels down, then one back up
// over the same distance, so net displacement across a cycle is zero.
const NUDGE_PX = 600;
const NUDGE_DOWN_STEPS = 4;
// Beat between a nudge and the read that judges it: the mount it waits on is an
// IntersectionObserver callback, which needs a frame after the scroll lands.
const NUDGE_SETTLE_MS = 1_200;
// Second chance after the one-shot reload below. Short: a page that re-injects mounts
// within a beat, and this budget is paid by every failing wait.
const RELOAD_RETRY_MS = 15_000;

// Covers slow loads and lazy IntersectionObserver mounting, so a host-presence check
// distinguishes "not logged in / no host" from "page still loading". Returns the max
// visible host count seen, or zero when none appeared within the timeout.
export async function waitForHost(bridge: Bridge, site: SiteId, timeoutMs = 12_000): Promise<number> {
  let deadline = Date.now() + timeoutMs;
  // Stalls are refunded below, so a wedged bridge would otherwise loop forever. Past
  // this ceiling the stalls become the verdict.
  let hardDeadline = Date.now() + timeoutMs * 2;
  let max = 0;
  let reads = 0;
  let failedReads = 0;
  let consecutiveFails = 0;
  let downSteps = 0;
  let lastError: unknown = null;
  let reloaded = false;
  for (;;) {
    reads += 1;
    const readStartedAt = Date.now();
    const ev = await readEvidence(bridge, site).catch((err: unknown) => {
      if (!isBridgeError(err)) throw err; // a probe that threw in the page is not a lost read
      failedReads += 1;
      consecutiveFails += 1;
      lastError = err;
      return null;
    });
    // Two lost reads in a row is a dead relay: refunding their time (below) would
    // hold this loop open for the whole hard ceiling on a bridge that will never
    // answer again.
    if (consecutiveFails >= 2) throw bridgeReadFailure(site, failedReads, reads, lastError);
    if (ev) {
      consecutiveFails = 0;
      max = Math.max(max, ev.visibleHostCount);
    }
    // A stalled read costs the bridge's call ceiling plus its retry (~61s), more
    // than this whole budget on the short waits. Charging it would close the window
    // after one observation and return 0 - "log into <site>" for a wedged bridge. The
    // budget measures how long the page was looked at, so time the bridge spent
    // stuck does not count against it.
    else deadline += Date.now() - readStartedAt;
    if (max >= 1) return max;
    const stalledOut = Date.now() >= hardDeadline;
    if (Date.now() >= deadline || stalledOut) {
      if (failedReads === reads || (stalledOut && failedReads > 0)) {
        throw bridgeReadFailure(site, failedReads, reads, lastError);
      }
      // Zero hosts on a readable page: name the environment faults that produce one -
      // a background tab, then a recognized anti-bot wall - before the caller's
      // "log into <site>" assert fires.
      const backgrounded = await backgroundedTabFault(bridge, site);
      if (backgrounded) throw backgrounded;
      const wall = await bridgeWallReason(bridge);
      if (wall) throw wallFailure(site, wall);
      // A content script that lost its extension context (the service worker recycled
      // under it, a soft navigation orphaned it) injects nothing and never recovers on
      // its own - the page reads perfectly and has no Emojery in it. A reload
      // re-injects. (The "0 hosts on every site for a whole file" runs that first
      // motivated this were the background tab above, which a reload cannot fix.)
      if (!reloaded) {
        reloaded = true;
        await bridge.reload().catch(() => {});
        const second = Math.min(timeoutMs, RELOAD_RETRY_MS);
        deadline = Date.now() + second;
        hardDeadline = Date.now() + second * 2;
        continue;
      }
      return max;
    }
    // Lazy IntersectionObserver mounting (especially the Facebook feed) needs a scroll
    // nudge to surface a host, and reading at the top alone sees 0 on a slow feed. A
    // keyed anchor with no host anywhere IS that pending state - marker set, mount
    // owed - so aim straight at it. Otherwise sweep, and sweep BACK: a one-way wheel
    // walks thousands of pixels off a single-target page whose row sits near the top,
    // and the observer it waits on can then never fire.
    const pending = ev !== null && ev.hostCount === 0 && ev.siteKeyCount > 0;
    let nudge: string;
    if (pending) {
      nudge = boundedSrc(`await page.evaluate(() => { const anchor = document.querySelector('[data-khasky-emojery-mounted]'); if (anchor) anchor.scrollIntoView({ block: 'center' }); }).catch(() => {});`);
    } else if (downSteps >= NUDGE_DOWN_STEPS) {
      nudge = wheelBySrc(String(-NUDGE_PX * downSteps));
      downSteps = 0;
    } else {
      downSteps += 1;
      nudge = wheelBySrc(String(NUDGE_PX));
    }
    // The nudge and the settle are bridge calls too, so their failure belongs to the
    // bridge. Swallowing them while the budget kept running is how ONE stalled nudge
    // (~61s) closed a 15s window and returned 0, reported as "log into <site>" for an
    // account that was signed in. They are charged like a lost read: time refunded,
    // failure counted.
    const nudgeStartedAt = Date.now();
    const nudged = await bridge.act(nudge).then(
      () => true,
      () => false,
    );
    const settled = await bridge.waitMs(NUDGE_SETTLE_MS).then(
      () => true,
      () => false,
    );
    // Only a read that ANSWERED clears the run of failures. Otherwise a working nudge
    // between two lost reads would hide the dead relay they add up to.
    if (nudged && settled) continue;
    failedReads += 1;
    consecutiveFails += 1;
    deadline += Date.now() - nudgeStartedAt;
    if (consecutiveFails >= 2) throw bridgeReadFailure(site, failedReads, reads, lastError);
  }
}

// Every trigger click while Emojery is signed OUT opens a fresh auth.html tab in the
// connected REAL Chrome, so without a breaker a signed-out run floods the browser
// with dozens of them. Close each spawned tab immediately and count it. Past the cap,
// the whole run aborts with the root cause.
const AUTH_TAB_LIMIT = 10;
let authTabsSeen = 0;

export async function closeSpawnedAuthTabs(bridge: Bridge): Promise<number> {
  const closed = await bridge
    .run<number>(
      `let closed = 0;
       for (const p of page.context().pages()) {
         const u = p.url();
         if (u.startsWith('chrome-extension://') && u.includes('/auth.html')) {
           await p.close().catch(() => {});
           closed += 1;
         }
       }
       return closed;`,
    )
    .catch(() => 0);
  authTabsSeen += closed;
  if (authTabsSeen >= AUTH_TAB_LIMIT) {
    throw recordSetupFault(`Aborting: trigger clicks opened ${authTabsSeen} auth.html tabs - Emojery is SIGNED OUT in the connected Chrome. Sign in with the test account (E2E_AUTH_EMAIL / E2E_AUTH_OTP) in that Chrome, and confirm chrome://extensions shows the build this suite drives. ${MANUAL_SIGNIN_HINT}`);
  }
  return closed;
}

// Clicks the first VISIBLE trigger, then reports whether the emoji grid (authed) or
// a sign-in CTA (unauthed) is shown. The filter picks the visible trigger, because a
// permalink page can carry a second, off-screen host that .first() in DOM order would
// reach, and on a Facebook post permalink the photo overlaps the action-row region.
// force skips the actionability wait the site's own overlays would block.
export async function openPickerState(bridge: Bridge): Promise<PickerState> {
  await dismissBlockingDialogs(bridge); // clear any modal that would eat the click
  await bridge.act(`await page.locator(${JSON.stringify(TRIGGER_SELECTOR)}).filter({ visible: true }).first().click({ force: true, timeout: 8000 }).catch(() => {});`);
  // The popover needs a beat to render before the one-shot state probe below.
  await bridge.waitMs(1200);
  let st = await bridge.evaluate<PickerState>(pickerStateProbe());
  // A spawned auth tab means the extension is signed out: report the unauthed state
  // and DON'T retry via keyboard - another click would only open another tab.
  if (await closeSpawnedAuthTabs(bridge)) return { ...st, authTabHint: true };
  // Fallback for layouts where a site element overlaps the trigger and eats the
  // coordinate click (Facebook photo permalinks): open via keyboard, focus + Enter.
  if (!st.gridVisible && !st.authTabHint) {
    await bridge.act(
      `const t = page.locator(${JSON.stringify(TRIGGER_SELECTOR)}).filter({ visible: true }).first();
       await t.scrollIntoViewIfNeeded().catch(() => {});
       await t.focus().catch(() => {});
       await page.keyboard.press('Enter').catch(() => {});`,
    );
    // Same render beat for the keyboard-opened popover before re-probing.
    await bridge.waitMs(1000);
    st = await bridge.evaluate<PickerState>(pickerStateProbe());
    if (await closeSpawnedAuthTabs(bridge)) return { ...st, authTabHint: true };
  }
  return st;
}

// A VISIBLE emoji the user has not already selected, so the round-trip always ends in
// a new selection. Picking an already-selected emoji toggles the reaction OFF (GitHub
// 59 to 58, no selection after reload), which persistence reads as a failure.
export async function pickFirstEmoji(bridge: Bridge): Promise<void> {
  await bridge.act(
    `const items = page.locator(${JSON.stringify(GRID_ITEM_SELECTOR)}).filter({ visible: true });
     const n = await items.count();
     let pick = 0;
     for (let i = 0; i < Math.min(n, 12); i++) {
       const checked = await items.nth(i).getAttribute('aria-pressed').catch(() => null);
       if (checked !== 'true') { pick = i; break; }
     }
     const target = items.nth(pick);
     // Normal click (NOT force): the grid is a tall scrollable popover, so a forced
     // click can fire at off-screen coordinates and miss (especially Facebook
     // overlap). A normal click scrolls the option into view first. Its actionability
     // wait is what a busy page eats into (a GitLab issue page timed a resolved,
     // visible grid item out at 8s), so the budget is generous while still fitting
     // the call ceiling.
     await target.scrollIntoViewIfNeeded().catch(() => {});
     await target.click({ timeout: 12000 });`,
  );
  // The pick lands after the content script's round-trip to the service worker.
  await bridge.waitMs(1200);
}

export async function visibleGridCount(bridge: Bridge): Promise<number> {
  return bridge.run<number>(`return await page.locator(${JSON.stringify(GRID_ITEM_SELECTOR)}).filter({ visible: true }).count();`);
}

// Type into the picker's search box in the open popover.
export async function searchInOpenPicker(bridge: Bridge, query: string): Promise<void> {
  await bridge.act(`await page.locator(${JSON.stringify(SEARCH_INPUT_SELECTOR)}).filter({ visible: true }).first().fill(${JSON.stringify(query)});`);
  // The search is debounced, so let the narrowed grid render before a caller counts it.
  await bridge.waitMs(500);
}

// "Still clickable after a deep feed scroll", without leaving state behind.
export async function triggerStillClickable(bridge: Bridge): Promise<boolean> {
  const ok = await bridge
    .run<boolean>(
      `try {
         await page.locator(${JSON.stringify(TRIGGER_SELECTOR)}).filter({ visible: true }).first().click({ force: true, timeout: 6000 });
         return true;
       } catch { return false; }`,
    )
    .catch(() => false);
  await bridge.press("Escape").catch(() => {});
  await closeSpawnedAuthTabs(bridge);
  return ok;
}

// Chrome's performance.memory, at reduced precision. Logged as a heuristic. The suite
// never asserts on it.
export async function usedHeapMb(bridge: Bridge): Promise<number | null> {
  return bridge
    .evaluate<number | null>(
      `const m = (performance && performance.memory) ? performance.memory.usedJSHeapSize : null;
       return m == null ? null : Math.round(m / 1048576);`,
    )
    .catch(() => null);
}

const MANUAL_SIGNIN_HINT = "The bridge attaches to a single tab and cannot open chrome-extension:// pages, so it can NEVER sign Emojery in for you - do it by hand in the Emojery popup, then re-run.";

// A missing extension or signed-out Emojery is a SETUP fault: no retry and no later
// file can clear it. Remember the first verdict so every remaining file aborts in
// milliseconds, sparing every remaining file ~25s of re-driving GitHub and burying the
// one real cause under identical stack traces. Module state survives across files here
// (single fork, isolate: false).
let setupFault: string | null = null;

function recordSetupFault(message: string): Error {
  setupFault = message;
  return new Error(message);
}

// Opens the picker on GitHub, a login-free surface: the grid only renders when
// Emojery is signed in, else clicking the trigger opens auth.
export async function assertEmojerySignedIn(bridge: Bridge): Promise<void> {
  await gotoSettled(bridge, authContentUrl("github"), 3000);
  // A slow load outlasts the settle above, so reload once if there is still nothing.
  let hosts = await waitForHost(bridge, "github", 12_000);
  if (hosts < 1) {
    await bridge.reload();
    await bridge.waitMs(2500);
    hosts = await waitForHost(bridge, "github", 12_000);
  }
  if (hosts < 1) {
    throw recordSetupFault("Emojery did not mount on GitHub via the bridge - load + enable the Emojery extension (Load unpacked .output/chrome-mv3-staging) in the connected Chrome.");
  }
  const picker = await openPickerState(bridge);
  await bridge.press("Escape").catch(() => {});
  if (!picker.gridVisible) {
    throw recordSetupFault(`Emojery is SIGNED OUT in the connected Chrome - the trigger opened the sign-in CTA instead of the emoji grid. Sign in with the test account (E2E_AUTH_EMAIL / E2E_AUTH_OTP) in that Chrome, and confirm chrome://extensions shows the build this suite drives. ${MANUAL_SIGNIN_HINT}`);
  }
}

// Per-file bridge lifecycle: the suite runs file-sequentially, so each file owns one
// connection. setup FAILS FAST (throws) when the bridge cannot attach to your real
// Chrome or Emojery isn't signed in, so a missing setup is never a silent skip.
//
// vitest's retry covers tests and never hooks, so a single transient inside setup (the
// cold relay bootstrap the first file pays, or one bridge call that stalls into its
// 30s ceiling and its retry) killed the whole file with an unactionable "Hook timed
// out in 120000ms". Setup now retries itself once on a FRESH connection. A real setup
// fault (recordSetupFault) is never retried.
const SETUP_ATTEMPTS = 2;

// The hook budget every file gives fx.setup, in ONE place - it was copied into six
// files as a bare 120_000, below what a single attempt can cost. One attempt is
// bounded by the bridge's own ceilings at ~60s, plus the signed-in probe navigating
// GitHub twice and driving the picker. Two attempts fit here with headroom, so a
// reader sees setup's own actionable message where vitest would print "Hook timed out".
export const SETUP_HOOK_TIMEOUT_MS = 300_000;

interface BridgeFixture {
  setup(): Promise<void>;
  teardown(): Promise<void>;
  /** Throws, never skips: a missing bridge is a setup mistake to fix, and a silent
   *  skip would hide it. */
  need(): Bridge;
}
export function bridgeFixture(): BridgeFixture {
  let bridge: Bridge | null = null;
  return {
    setup: async () => {
      if (!siteAuthEnabled()) return;
      // Cheapest check first, so a wrong-env run fails in milliseconds and skips the
      // ~25s of browser work per file that would end in a misleading "sign in" message.
      const buildProblem = stagingBuildProblem();
      if (buildProblem) {
        throw new Error(`Site-auth suite is pointed at the WRONG BUILD. ${buildProblem} ${WRONG_BUILD_HINT}`);
      }
      // An earlier file already proved the extension is missing or signed out.
      if (setupFault) throw new Error(`Aborted before connecting - a previous file already hit this: ${setupFault}`);
      let lastError: unknown;
      for (let attempt = 1; attempt <= SETUP_ATTEMPTS; attempt++) {
        try {
          bridge = await tryConnect();
          if (!(await attachedToRealBrowser(bridge))) {
            throw new Error("Site-auth bridge did not attach to your real Chrome (saw only about:blank). The Playwright Extension isn't bridged - re-copy the token from its popup and retry.");
          }
          await assertEmojerySignedIn(bridge);
          return;
        } catch (err) {
          lastError = err;
          // Drop the half-dead connection, closing its connect.html tab, so the next
          // attempt starts from a clean relay.
          await bridge?.close().catch(() => {});
          bridge = null;
          if (setupFault) throw err;
          if (attempt < SETUP_ATTEMPTS) console.log(`[site-auth] setup attempt ${attempt}/${SETUP_ATTEMPTS} failed (${String(err).slice(0, 200)}) - reconnecting once`);
        }
      }
      throw lastError;
    },
    teardown: async () => {
      await bridge?.close().catch(() => {});
      bridge = null;
    },
    need: () => {
      if (!bridge) {
        throw new Error("site-auth bridge not initialized - setup failed (see the beforeAll error).");
      }
      return bridge;
    },
  };
}
