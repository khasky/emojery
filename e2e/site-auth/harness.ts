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

// The backend this run targets, from the same env var the rest of the suite
// reads (`.env.e2e`) - never hardcoded here. Null when unset or unparsable, in
// which case the build/backend comparison below has nothing to compare against.
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

// Which build is loaded in the user's Chrome is NOT observable from a content
// page (the bridge can't reach chrome-extension:// pages), so we gate on the one
// thing we can see locally: whether a staging build exists at all. Missing =>
// whatever is loaded is definitely not it. Returns null when the build is fine.
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

// Connect once. Failing here is FATAL for the run (the suite never skips - see
// bridgeFixture below): rethrow the setup advice with the underlying error as
// `cause`, so a stale token, a Chrome that isn't running and a failed
// @playwright/mcp import stay distinguishable instead of collapsing into one
// generic message.
async function tryConnect(): Promise<Bridge> {
  try {
    return await connectBridge();
  } catch (err) {
    throw new Error("Site-auth bridge could not connect. Start Chrome with the Playwright Extension running and set a CURRENT PLAYWRIGHT_MCP_EXTENSION_TOKEN (copy it from the extension popup). See e2e/site-auth/README.md.", { cause: err });
  }
}

// Confirm we're attached to the REAL browser, not a throwaway one the server
// launched: real Chrome has user tabs, a throwaway shows a single about:blank.
// NOT a check that `page` is an ordinary tab: with nothing selected in the
// Playwright Extension the relay hands us its own connect.html page, and the
// first goto legitimately navigates that tab onto the site (bridge.ts closes it
// again on teardown, so it is not the tab leak it looks like).
async function attachedToRealBrowser(bridge: Bridge): Promise<boolean> {
  const urls = await bridge.tabUrls().catch(() => [] as string[]);
  if (urls.length === 0) return false;
  if (urls.length === 1 && urls[0] === "about:blank") return false;
  return true;
}

export function mountKeyPattern(site: SiteId): string {
  // Union of the site's scenario patterns from the shared registry. NOTE: only
  // reddit's patterns are uniformly tight - for the other sites at least one
  // scenario uses a bare '^site:', so the union is effectively that. Tighten the
  // registry patterns to tighten this.
  const patterns = SUPPORTED_SITE_SCENARIOS.filter((s) => s.site === site).map((s) => s.mountKeyPattern);
  return patterns.length > 0 ? patterns.map((p) => `(?:${p})`).join("|") : `^${site}:`;
}

// Pause + mute any media so a video page (YouTube) doesn't blast audio while the
// suite runs. Cheap no-op on non-video pages.
export async function muteMedia(bridge: Bridge): Promise<void> {
  await bridge.act(`await page.evaluate(() => { for (const v of document.querySelectorAll('video, audio')) { try { v.pause(); v.muted = true; } catch {} } }).catch(() => {});`).catch(() => {});
}

// Dismiss known full-screen interstitials that block scroll/clicks. Currently:
// X's "Review your email" modal - closed via "Yes, that's correct" (a benign
// confirmation; it does NOT change the account). The button label is
// X-specific, so attempting it on other sites is a cheap no-op (count()===0).
// Bridge-side source so it can also ride along inside another call's body.
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

// Harness-internal: every helper here that clicks or reads sweeps first, so a
// test does not need to call it itself.
async function dismissBlockingDialogs(bridge: Bridge): Promise<void> {
  await bridge.act(DISMISS_BLOCKING_DIALOGS_SRC).catch(() => {});
}

// Condition-first settle, the same shape the autonomous route uses in
// lib/page-settle.ts: what every caller polls for next is a painted host, so
// stop waiting the moment one appears. `settleMs` is only the CEILING - a page
// that never mounts (wall, disabled site, a row still below the fold) pays it in
// full, exactly as the flat wait always did. `.khasky-emojery-host` is light DOM,
// so a plain query reaches it; the round-trip itself is the floor.
const HOST_PAINTED = `return Array.from(document.querySelectorAll('.khasky-emojery-host')).some((h) => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; });`;

// Two URLs the bridge may treat as the same destination: a site redirects within
// its own host (login hops, canonical paths, an SPA rewriting the path), and none of
// that means the navigation missed. A DIFFERENT host - or about:blank - does.
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
  // `bridge.goto` swallows its own failure by design, so a navigation that never
  // committed leaves the bridge measuring the PREVIOUS page - or the blank tab it
  // opened to work in, which reads perfectly and has no Emojery in it. That is
  // indistinguishable from "this site mounted nothing" at every later read, so
  // confirm the landing and re-try it once. Costs one ~8ms read per navigation.
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

// The bridge twin of lib/site-walls.ts `wallReason`, running the same two
// checks (BLOCK_URL_RE on the final URL, then the exact WALL_SENTENCES_RE
// through a locator - it must pierce the open shadow root Reddit renders its
// network-security wall into) as serialized source, because the bridge executes
// strings, not closures. Any bridge failure reads as "no wall seen": this probe
// only upgrades a zero-host diagnosis, it must never invent one.
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

// A recognized wall is an ENVIRONMENT failure, not a missing login: the walls
// hit this suite's real, signed-in Chrome too (verified live - Reddit served
// both its network-security block and its "Prove your humanity" reCAPTCHA on
// this suite's own fixture URLs). Without this verdict every zero-host test
// failed with "log into <site>" and sent the reader after a login that was
// never the problem - the same lesson waitForHost records for a dead bridge.
function wallFailure(site: SiteId, wall: string): Error {
  return new Error(`${site}: the page served an anti-bot / login wall instead of the content - ${wall}. Solve or dismiss the challenge in the connected Chrome, then re-run. This is NOT a missing ${site} login.`);
}

// The message every "did the picker mount on this surface?" assert fails with. One copy so
// a wording fix reaches all of them; a caller with more to say appends its own sentence.
// The brand name comes from the registry, so it reads "GitLab" rather than a capitalized id.
export function noHostMounted(site: SiteId, extra?: string): string {
  return `${site}: no Emojery host mounted - log into ${SITE_LABELS[site]} in the connected Chrome.${extra ? ` ${extra}` : ""}`;
}

// What the probe was actually looking at when it saw nothing. A zero-host verdict
// names a login by default, and that reading is worth nothing once the same verdict
// lands on 8 sites in a row - the URL and the anchor count say in one line whether
// the bridge was on the page the test meant, and whether the content script ran at
// all. Best-effort: a bridge that cannot answer this has already said enough.
export async function zeroHostEvidence(bridge: Bridge, site: SiteId): Promise<string> {
  const ev = await readEvidence(bridge, site).catch(() => null);
  if (!ev) return "The bridge could not re-read the page for a diagnosis.";
  return `The bridge was looking at ${ev.url} with ${ev.mountKeys.length} Emojery anchor(s) on it - no anchors at all means the content script did not run there.`;
}

// `page.mouse.wheel` resolves only once the RENDERER acknowledges the input event,
// and it takes no timeout - so a feed whose main thread is busy holds the call until
// the bridge's own ceiling. Measured on the facebook feed: 61s, twice, where a
// scripted scroll in the same place returned in under 4s. Every wheel therefore runs
// against this budget: the wheel is what a site's own wheel handlers and inner scroll
// containers need, so it stays the instrument, but a blocked renderer costs seconds
// instead of a minute and the queued event still lands on its own.
const WHEEL_ACK_BUDGET_MS = 4_000;

// Bridge-side source that stops WAITING on `bodySrc` past the budget without
// stopping the work: a queued wheel still lands, an evaluate still finishes. What it
// bounds is the call, so a renderer that is merely busy costs a beat instead of the
// whole per-call ceiling. `page.waitForTimeout` is a Node-side sleep in Playwright,
// so it fires while the renderer is wedged.
function boundedSrc(bodySrc: string, budgetMs: number = WHEEL_ACK_BUDGET_MS): string {
  return `{ const __bounded = (async () => { ${bodySrc} })(); __bounded.catch(() => {}); await Promise.race([__bounded, page.waitForTimeout(${budgetMs})]); }`;
}

export function wheelBySrc(deltaExpr: string): string {
  return boundedSrc(`await page.mouse.wheel(0, ${deltaExpr});`);
}

// Scroll a feed in steps and report the max matching-visible host count seen,
// re-reading evidence each step (covers virtualization + lazy IO mounting).
// Zero hosts across every step with a recognized wall on screen throws the wall
// verdict instead of letting the caller's "log into <site>" assert fire.
export async function scrollAndCountHosts(bridge: Bridge, site: SiteId, steps: number): Promise<{ maxVisible: number; sawDuplicate: boolean }> {
  let maxVisible = 0;
  let sawDuplicate = false;
  let failedReads = 0;
  let consecutiveFails = 0;
  let lastError: unknown = null;
  for (let i = 0; i < steps; i++) {
    // One lost read must not kill a multi-step walk: the remaining steps still
    // observe the page. Only a BRIDGE failure is tolerated that way - a probe that
    // threw in the page is this suite's own bug and goes straight up.
    const ev = await readEvidence(bridge, site).catch((err: unknown) => {
      if (!isBridgeError(err)) throw err;
      failedReads += 1;
      consecutiveFails += 1;
      lastError = err;
      return null;
    });
    if (!ev) {
      // TWO lost reads in a row is a dead relay, not a lost frame. Walking the
      // remaining steps then costs ~61s each (20 of them on the deep sites) and
      // still reports whatever the surviving steps saw - a green test on a page
      // nobody was watching. Name the bridge instead, now.
      if (consecutiveFails >= 2) throw bridgeReadFailure(site, failedReads, i + 1, lastError);
      // Don't scroll on a lost step: the next read then re-tries the same viewport
      // instead of walking past content nothing ever observed.
      continue;
    }
    consecutiveFails = 0;
    maxVisible = Math.max(maxVisible, ev.visibleHostCount);
    // Confirm a duplicate persists before counting it: a re-render can briefly
    // leave two anchors on one key mid-mutation (verified live on an IG post -
    // a transient that cleared after settle), which would otherwise flake.
    if (ev.duplicateKeys.length > 0) {
      await bridge.waitMs(1200);
      const recheck = await readEvidence(bridge, site);
      if (recheck.duplicateKeys.length > 0) sawDuplicate = true;
    }
    // Wheel + settle + the blocking-dialog sweep (a modal can pop mid-scroll) in
    // ONE bridge call: a round-trip costs ~0.7s of its own, and this loop runs up
    // to 20 times per site. The sweep rides at the END of a step, so every
    // evidence read above still follows one - gotoSettled sweeps before the first.
    //
    // A step that cannot scroll is the BRIDGE failing, exactly like a lost read: it
    // used to be the one call here nobody caught, so a stall in it left the walk as
    // a bare McpError with no site in it (seen live on reddit and github).
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
    const wall = await bridgeWallReason(bridge);
    if (wall) throw wallFailure(site, wall);
  }
  return { maxVisible, sawDuplicate };
}

// A read that THROWS is not a missing host - it is a dead tab, a crashed page or
// a bridge -32001 that survived its retry. Reporting 0 for those turns a broken
// connection into "log into <site>", sending the reader after a login that was
// never the problem (the same lesson auto-press.test.ts records for unReact).
function bridgeReadFailure(site: SiteId, failedReads: number, reads: number, cause: unknown): Error {
  return new Error(`Site-auth bridge could not read the page (${failedReads}/${reads} probes failed) - this is a bridge/tab failure, NOT a missing ${site} login. Check the connected Chrome and the Playwright Extension token.`, { cause });
}

// A logged-in permalink hydrates far later than a feed - measured on a Facebook
// /posts/ permalink, the action row mounted ~45s after the navigation committed
// - so every detail/permalink surface shares this budget while feeds keep
// waitForHost's shorter default. Tests that spend it need a matching budget of
// their own (PERMALINK_TEST_TIMEOUT_MS), since one crosses such a page twice.
export const PERMALINK_HOST_WAIT_MS = 60_000;
export const PERMALINK_TEST_TIMEOUT_MS = 240_000;

// One bounded sweep of the nudge below: four wheels down, then one wheel back up
// over the same distance. Net displacement across a cycle is zero.
const NUDGE_PX = 600;
const NUDGE_DOWN_STEPS = 4;
// Beat between a nudge and the read that judges it: the mount it is waiting on is an
// IntersectionObserver callback, which needs a frame after the scroll lands.
const NUDGE_SETTLE_MS = 1_200;
// Second chance after the one-shot reload below. Short on purpose: a page that
// re-injects mounts within a beat, and this budget is paid by every failing wait.
const RELOAD_RETRY_MS = 15_000;

// Poll for a visible Emojery host on the current page (covers slow loads / lazy
// IntersectionObserver mounting), so a host-presence check distinguishes "not
// logged in / no host" from "page still loading". Returns the max visible host
// count seen (0 = none within the timeout).
export async function waitForHost(bridge: Bridge, site: SiteId, timeoutMs = 12_000): Promise<number> {
  let deadline = Date.now() + timeoutMs;
  // Stalls are refunded below, so a wedged bridge would otherwise loop here
  // forever; past this ceiling the stalls ARE the verdict.
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
    // otherwise hold this loop open for the whole hard ceiling on a bridge that
    // will never answer again.
    if (consecutiveFails >= 2) throw bridgeReadFailure(site, failedReads, reads, lastError);
    if (ev) {
      consecutiveFails = 0;
      max = Math.max(max, ev.visibleHostCount);
    }
    // A stalled read costs the bridge's call ceiling plus its retry (~61s) -
    // more than this whole budget on the short waits. Charging it would close
    // the window after a single observation and return 0, i.e. "log into
    // <site>" for what was a wedged bridge. The budget measures how long we
    // LOOKED at the page, not how long the bridge was stuck.
    else deadline += Date.now() - readStartedAt;
    if (max >= 1) return max;
    const stalledOut = Date.now() >= hardDeadline;
    if (Date.now() >= deadline || stalledOut) {
      if (failedReads === reads || (stalledOut && failedReads > 0)) {
        throw bridgeReadFailure(site, failedReads, reads, lastError);
      }
      // Zero hosts on a readable page: before the caller's "log into <site>"
      // assert fires, check whether the page is a recognized anti-bot wall.
      const wall = await bridgeWallReason(bridge);
      if (wall) throw wallFailure(site, wall);
      // A content script that lost its extension context (the service worker
      // recycled under it, a soft navigation left it orphaned) injects nothing and
      // never recovers on its own - the page reads perfectly and simply has no
      // Emojery in it. A reload re-injects, which is the same one-shot recovery
      // assertEmojerySignedIn has always used. Seen live as 10 tests in a row
      // reporting 0 hosts on every site, including github and amazon, in a run
      // whose other 6 files were green.
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
    // Lazy IntersectionObserver mounting (esp. the FB feed) often needs a scroll
    // nudge to surface a host - reading at the top alone can see 0 on a slow feed.
    // A keyed anchor with no host anywhere IS that pending state - marker set,
    // mount owed - so aim straight at it. Otherwise sweep, and sweep BACK: a
    // one-way wheel walks thousands of pixels off a single-target page whose row
    // sits near the top, and the observer it is waiting on can then never fire
    // (seen live: "youtube: no Emojery host mounted" twice in one run, both green
    // on a rerun - and every 60s detail wait in the last run died this way).
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
    // The nudge and the settle are bridge calls too, and their failure is the
    // bridge's - never the page's. Swallowing them while the budget kept running is
    // how ONE stalled nudge (~61s) closed a 15s window and returned 0, which the
    // caller then reported as "log into <site>" for an account that was signed in
    // (seen live: the 2 facebook wall audits and the threads round-trip). Charged
    // like a lost read instead - time refunded, failure counted.
    const nudgeStartedAt = Date.now();
    const nudged = await bridge.act(nudge).then(
      () => true,
      () => false,
    );
    const settled = await bridge.waitMs(NUDGE_SETTLE_MS).then(
      () => true,
      () => false,
    );
    // A nudge that worked says nothing about the reads: only a read that ANSWERED
    // clears the run of failures, or a working nudge between two lost reads would
    // hide the dead relay they add up to.
    if (nudged && settled) continue;
    failedReads += 1;
    consecutiveFails += 1;
    deadline += Date.now() - nudgeStartedAt;
    if (consecutiveFails >= 2) throw bridgeReadFailure(site, failedReads, reads, lastError);
  }
}

// Every trigger click while Emojery is signed OUT opens a fresh auth.html tab in
// the connected REAL Chrome, so without a breaker a signed-out run floods the
// browser with them while test after test keeps clicking (seen live: dozens
// across an 11-failure run). Close each spawned tab immediately and count it;
// past the cap, abort the whole run with the root cause.
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

// Open the picker by clicking the first VISIBLE trigger, then report whether the
// emoji grid (authed) or a sign-in CTA (unauthed) is shown. We must target the
// *visible* trigger (`filter({ visible: true })`), not `.first()` in DOM order -
// a permalink page can carry a second, off-screen host, and a coordinate click
// would also risk landing on an overlapping site element (verified on a FB post
// permalink, where the post photo overlaps the action-row region). `force` skips
// the actionability wait that the site's own overlays can otherwise block.
export async function openPickerState(bridge: Bridge): Promise<PickerState> {
  await dismissBlockingDialogs(bridge); // clear any modal that would eat the click
  await bridge.act(`await page.locator(${JSON.stringify(TRIGGER_SELECTOR)}).filter({ visible: true }).first().click({ force: true, timeout: 8000 }).catch(() => {});`);
  // The popover needs a beat to render before the one-shot state probe below.
  await bridge.waitMs(1200);
  let st = await bridge.evaluate<PickerState>(pickerStateProbe());
  // A spawned auth tab means the extension is signed out: report it as the
  // unauthed state and DON'T retry via keyboard - another click would only
  // open another tab.
  if (await closeSpawnedAuthTabs(bridge)) return { ...st, authTabHint: true };
  // Fallback for layouts where a site element overlaps the trigger and eats the
  // coordinate click (verified on FB photo permalinks): open via keyboard
  // (focus + Enter), like the autonomous suite's `openPickerWithVisibleUserAction`.
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

// Pick a VISIBLE emoji the user has NOT already selected, so the round-trip
// always results in a *new* selection. Picking an already-selected emoji would
// toggle the reaction OFF (verified live on a re-run: GitHub 59 to 58, no selection
// after reload), which the persistence assertion would then read as a failure.
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
     // click can fire at off-screen coordinates and miss (esp. FB overlap). A normal
     // click scrolls the option into view first. Its actionability wait is what a
     // busy page eats into (a GitLab issue page timed a resolved, visible grid item
     // out at 8s), so the budget is generous while still fitting the call ceiling.
     await target.scrollIntoViewIfNeeded().catch(() => {});
     await target.click({ timeout: 12000 });`,
  );
  // The optimistic pick lands after the content script's round-trip to the
  // service worker; give it a beat before the caller reads the trigger.
  await bridge.waitMs(1200);
}

export async function visibleGridCount(bridge: Bridge): Promise<number> {
  return bridge.run<number>(`return await page.locator(${JSON.stringify(GRID_ITEM_SELECTOR)}).filter({ visible: true }).count();`);
}

// Type into the picker's search box (it lives in the open popover).
export async function searchInOpenPicker(bridge: Bridge, query: string): Promise<void> {
  await bridge.act(`await page.locator(${JSON.stringify(SEARCH_INPUT_SELECTOR)}).filter({ visible: true }).first().fill(${JSON.stringify(query)});`);
  // The search is debounced; let the narrowed grid render before a caller counts it.
  await bridge.waitMs(500);
}

// Trial-clicks the first visible trigger open and closes it again - black-box
// "still clickable after a deep feed scroll" without leaving state behind.
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

// Best-effort JS heap reading (Chrome's performance.memory, reduced precision).
// Returned for logging only - a perf heuristic, never a hard assertion.
export async function usedHeapMb(bridge: Bridge): Promise<number | null> {
  return bridge
    .evaluate<number | null>(
      `const m = (performance && performance.memory) ? performance.memory.usedJSHeapSize : null;
       return m == null ? null : Math.round(m / 1048576);`,
    )
    .catch(() => null);
}

const MANUAL_SIGNIN_HINT = "The bridge attaches to a single tab and cannot open chrome-extension:// pages, so it can NEVER sign Emojery in for you - do it by hand in the Emojery popup, then re-run.";

// A missing extension / signed-out Emojery is a SETUP fault: no retry, no later
// file and no other site can clear it. Remember the first verdict so every
// remaining file aborts on it in milliseconds instead of re-driving GitHub for
// ~25s each and burying the one real cause under identical stack traces. Module
// state survives across files here (single fork, `isolate: false`).
let setupFault: string | null = null;

function recordSetupFault(message: string): Error {
  setupFault = message;
  return new Error(message);
}

// Assert (loudly) that the Emojery extension is loaded AND signed in, by opening the
// picker on GitHub (login-free surface): the grid only renders when Emojery is signed
// in (else clicking the trigger opens auth). Throws an actionable error otherwise.
export async function assertEmojerySignedIn(bridge: Bridge): Promise<void> {
  await gotoSettled(bridge, authContentUrl("github"), 3000);
  // Poll for the host (a slow load outlasts the settle above); reload once if still nothing.
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

// Per-file bridge lifecycle. The suite runs file-sequentially (see the dedicated
// vitest config), so each file owns one connection: connect in `setup`, close in
// `teardown`. `setup` FAILS FAST (throws) when the bridge can't attach to your
// real Chrome or Emojery isn't signed in - so every file reports the missing setup
// immediately with an actionable message rather than silently skipping.
// vitest's `retry` covers TESTS, never hooks - so a single transient inside
// setup (the relay bootstrap that the first file of a run pays cold, or one
// bridge call that stalls into its 30s ceiling and its retry) killed the whole
// file with an unactionable "Hook timed out in 120000ms". Setup retries itself
// once on a FRESH connection instead; a real setup fault (recordSetupFault:
// missing extension, signed-out Emojery) is never retried - retrying can't fix
// it and only delays the actionable message.
const SETUP_ATTEMPTS = 2;

// The hook budget every file gives `fx.setup`, in ONE place (it was copied into
// six files as a bare 120_000, which is below what a single attempt can cost).
// One attempt is already bounded by the bridge's own ceilings: a cold relay
// bootstrap plus a stalled call and its retry is ~60s, and the signed-in probe
// then navigates GitHub twice and drives the picker. Two attempts fit here with
// headroom, so the failure a reader sees is setup's actionable message rather
// than vitest's bare "Hook timed out".
export const SETUP_HOOK_TIMEOUT_MS = 300_000;

interface BridgeFixture {
  setup(): Promise<void>;
  teardown(): Promise<void>;
  /** Throws (never skips) when setup failed - a missing bridge is a setup
   *  mistake to fix, and a silent skip would hide it (see the note above). */
  need(): Bridge;
}
export function bridgeFixture(): BridgeFixture {
  let bridge: Bridge | null = null;
  return {
    setup: async () => {
      if (!siteAuthEnabled()) return;
      // Cheapest check first: a wrong-env run fails here in milliseconds instead
      // of ~25s of browser work per file ending in a misleading "sign in" message.
      const buildProblem = stagingBuildProblem();
      if (buildProblem) {
        throw new Error(`Site-auth suite is pointed at the WRONG BUILD. ${buildProblem} ${WRONG_BUILD_HINT}`);
      }
      // An earlier file already proved the extension is missing or signed out -
      // don't reconnect and re-drive a page to rediscover the same thing.
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
          // Drop the half-dead connection (this also closes its connect.html
          // tab) so the next attempt starts from a clean relay.
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
