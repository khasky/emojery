// SPDX-License-Identifier: GPL-3.0-or-later
//
// What a user gets when they react FAST, reported as "I placed a lot of
// reactions quickly and not all of them were counted". The queue holds one record
// per target, the reaction the user wants there: a click made while the previous
// vote is still on the wire replaces that record instead of queueing behind it, so
// a burst sends fewer votes than clicks and the server ends on the LAST pick of
// each target. End to end: History lists every click (right emoji, right target,
// right order), the last vote the server took for each target carries its last
// pick, and the queue drains; a burst that meets a 429 waits out its Retry-After
// and still lands that last pick.
//
// The picker, the login-free GitHub/GitLab surfaces and the staging API are real;
// the 429 alone is answered by the harness, since the server's own limit is not
// the test's to know. The wire record below is the black-box answer to "what was
// counted" - the queue flushes from the service worker, whose requests
// context-level events see too.
import { type BrowserContext, type ElementHandle, expect, type Page, test } from "@playwright/test";
import * as ext from "./lib/extension";
import { pollForValue } from "./lib/picker-probes";
import { openHistoryTab } from "./lib/popup-probes";
import { queuedVoteCount } from "./lib/reaction-surface";
import { GRID_ITEM_SELECTOR, HISTORY_EMOJI_SELECTOR, HISTORY_LINK_SELECTOR, HISTORY_ROW_SELECTOR, HOST_SELECTOR, OVERLAY_HOST_SELECTOR } from "./lib/selectors";

// Tracing OFF for this file, on every attempt. The snapshotter re-serializes the
// picker's ~600-button grid after each action, which costs seconds per pick (the
// measurement behind the `on-first-retry` default in playwright.config.ts): a burst
// that slow never outruns the wire, so no click ever replaces a vote in flight and
// the traced run tests a different queue path. Failure screenshots are
// unaffected.
test.use({ trace: "off" });

const REQUIRES_SIGNIN = ext.signInSkipReason("the reaction-burst accounting checks");

// The accounting reads the vote responses off context.on("response"), which on
// Firefox never sees the background page's fetches (verified: a 10-click burst
// counted 0 on the wire with every click recorded in history) - chromium-only.
test.skip(ext.isFirefoxRun(), 'the vote responses are read off context.on("response"), which does not see Firefox\'s background-page fetches');

// A burst plus the popup round-trip.
const BURST_TIMEOUT_MS = Number(process.env.E2E_BURST_TEST_TIMEOUT_MS ?? 300_000);
const DRAIN_TIMEOUT_MS = 240_000;

// A clean burst: this case is about the accounting, so it stays modest and
// leaves room for the un-react that resets the target first.
const GITHUB_CLICKS = Number(process.env.E2E_BURST_CLEAN_GITHUB ?? 8);
const GITLAB_CLICKS = Number(process.env.E2E_BURST_CLEAN_GITLAB ?? 2);

// The Retry-After of the harness's 429: short, so the case measures the wait
// without spending a minute on it.
const REFUSAL_RETRY_AFTER_SEC = 3;

interface VoteResponse {
  status: number;
  /** `retry-after` seconds, present on a 429. */
  retryAfterSec: number | null;
  at: number;
  site: string;
  reaction: string;
}

// Every vote POST the extension makes, in wire order, without reaching into the
// extension's own storage for it.
function watchVoteResponses(context: BrowserContext): VoteResponse[] {
  const seen: VoteResponse[] = [];
  context.on("response", (response) => {
    if (new URL(response.url()).pathname !== "/v2/react") return;
    const retryAfter = Number(response.headers()["retry-after"]);
    const vote = (response.request().postDataJSON() ?? {}) as { site?: string; reaction?: string };
    seen.push({
      status: response.status(),
      retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      at: Date.now(),
      site: vote.site ?? "",
      reaction: vote.reaction ?? "",
    });
  });
  return seen;
}

const refusedVotes = (responses: VoteResponse[]): VoteResponse[] => responses.filter((r) => r.status === 429);

// The reaction the server last took for each site, from the votes it answered 200.
function lastCountedBySite(responses: VoteResponse[]): Record<string, string> {
  const last: Record<string, string> = {};
  for (const r of responses) if (r.status === 200) last[r.site] = r.reaction;
  return last;
}

// The burst is over once the queue holds nothing and the server took each target's
// last pick; asserting earlier only sees the votes sent so far.
async function expectBurstSettles(context: BrowserContext, seen: () => VoteResponse[], lastPicks: Record<string, string>): Promise<void> {
  await expect
    .poll(async () => ({ queued: await queuedVoteCount(context).catch(() => null), lastCounted: lastCountedBySite(seen()) }), {
      message: "the queue should drain with the server holding each target's last pick",
      timeout: DRAIN_TIMEOUT_MS,
      intervals: [1_000],
    })
    .toEqual({ queued: 0, lastCounted: lastPicks });
}

// The grid lives in an OPEN shadow root, so reading it from that root directly is
// what keeps a pick cheap: the document-wide shadow-piercing walk (lib/probe-src.ts)
// costs seconds per call on a heavy page like a big repo header, and per click
// that is what decides whether a burst outruns the wire at all.
const PICKER_GRID_ITEMS_SRC = `const pickerGridItems = () => {
  const out = [];
  for (const host of document.querySelectorAll("${OVERLAY_HOST_SELECTOR}, ${HOST_SELECTOR}")) {
    const root = host.shadowRoot;
    if (!root) continue;
    for (const item of root.querySelectorAll("${GRID_ITEM_SELECTOR}")) out.push(item);
  }
  return out;
};`;

// The option for one glyph, polled while the tray paints.
function pickerOption(page: Page, emoji: string, timeoutMs = 10_000): Promise<ElementHandle<HTMLElement> | null> {
  const read = async (): Promise<ElementHandle<HTMLElement> | null> => {
    const handle = await page.evaluateHandle<HTMLElement | null>(`(() => {
      ${PICKER_GRID_ITEMS_SRC}
      const glyph = ${JSON.stringify(emoji)};
      return pickerGridItems().find((item) => (item.textContent || "").trim() === glyph) ?? null;
    })()`);
    // `asElement()` types itself off the handle's value type, which the string
    // form of evaluateHandle cannot infer - the runtime result is the grid button
    // or null, exactly as the expression above returns it.
    const option = handle.asElement() as ElementHandle<HTMLElement> | null;
    if (!option) await handle.dispose().catch(() => {});
    return option;
  };
  // 100ms interval - short because a burst is being timed.
  return pollForValue(read, (option) => option !== null, timeoutMs, 100);
}

// One pick, the short way. The tray closes itself on every pick, so a burst is
// open-tray -> pick -> repeat.
//
// Keyboard, not a mouse click: clicking an option waits for the popover to stop moving
// and scrolls the whole palette grid, which costs seconds per pick - a burst that slow
// never has a click replace a vote in flight. Enter on a focused <button> is the
// trusted activation the picker
// requires, and it is coordinate-free like openPickerTray.
async function pickEmoji(page: Page, emoji: string): Promise<void> {
  await ext.openPickerTray(page);
  const option = await pickerOption(page, emoji);
  expect(option, `the picker should offer the ${emoji} option`).not.toBeNull();
  if (!option) return;
  await option.focus();
  await page.keyboard.press("Enter");
  await option.dispose().catch(() => {});
}

// The glyphs the picker renders, read from the open tray: a hardcoded
// list would go stale the day the palette changes, and a burst only needs "N
// different emoji the user can see". Selected ones are skipped so every pick is
// a switch, never a toggle-off.
async function pickerGlyphs(page: Page, count: number): Promise<string[]> {
  await ext.openPickerTray(page);
  await expect(page.locator(GRID_ITEM_SELECTOR).filter({ visible: true }).first()).toBeVisible({ timeout: 8_000 });
  const glyphs = await page.evaluate<string[]>(`(() => {
    ${PICKER_GRID_ITEMS_SRC}
    const out = [];
    const seen = new Set();
    for (const item of pickerGridItems()) {
      if (item.getAttribute("aria-pressed") === "true") continue;
      const glyph = (item.textContent || "").trim();
      if (!glyph || seen.has(glyph)) continue;
      seen.add(glyph);
      out.push(glyph);
    }
    return out;
  })()`);
  await page.keyboard.press("Escape").catch(() => {});
  expect(glyphs.length, "the picker grid should render enough distinct emoji for the burst").toBeGreaterThanOrEqual(count);
  return glyphs.slice(0, count);
}

// The host of the row's link is what says WHICH target the row belongs to.
interface ReactionRow {
  emoji: string;
  host: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

// The newest `count` History rows as the popup renders them. The emoji character
// stays in the DOM behind the sprite (ui/emoji-img.tsx), so a row's glyph reads
// back exactly as the grid offered it.
async function topHistoryRows(context: BrowserContext, count: number): Promise<ReactionRow[]> {
  const popup = await openHistoryTab(context, { waitForRows: true });
  try {
    // The callback runs in the page, where the imported selector constants do not
    // exist - they must travel as the evaluate argument.
    const rows = await popup.locator(HISTORY_ROW_SELECTOR).evaluateAll(
      (items, selectors) =>
        items.map((li) => ({
          emoji: (li.querySelector(selectors.emoji)?.textContent ?? "").trim(),
          href: li.querySelector(selectors.link)?.getAttribute("href") ?? "",
        })),
      { emoji: HISTORY_EMOJI_SELECTOR, link: HISTORY_LINK_SELECTOR },
    );
    return rows.slice(0, count).map((row) => ({ emoji: row.emoji, host: hostOf(row.href) }));
  } finally {
    await popup.close().catch(() => {});
  }
}

// An un-react is a vote like any other: let it land BEFORE the burst so it
// counts into neither the burst nor its History rows.
async function resetTarget(context: BrowserContext, page: Page): Promise<void> {
  await ext.ensureNoOwnReaction(context, page);
}

test("a fast burst answered 200 throughout is counted in full and every click shows in History", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_SIGNIN);
  test.setTimeout(BURST_TIMEOUT_MS);
  const session = await ext.launchSession();
  const responses = watchVoteResponses(session.context);
  try {
    const github = await ext.signedInGithubPage(session.context);
    await resetTarget(session.context, github);

    const glyphs = await pickerGlyphs(github, GITHUB_CLICKS + GITLAB_CLICKS);
    const sinceBurst = responses.length;
    const clicks: ReactionRow[] = [];
    const lastPicks: Record<string, string> = {};
    for (const glyph of glyphs.slice(0, GITHUB_CLICKS)) {
      await pickEmoji(github, glyph);
      clicks.push({ emoji: glyph, host: hostOf(ext.githubUrl()) });
      lastPicks.github = glyph;
    }

    // A second target, because the report is about reactions spread over
    // different pages, not one page reacted to repeatedly. GitLab is skipped
    // rather than failed when its header does not mount - that is a site-side
    // condition the placement suites own.
    // Not reset like the first target: an un-react here would land INSIDE the
    // burst as a row of its own. A reaction left on GitLab by an earlier run at
    // worst turns its first pick into a toggle-off, which is still one row carrying
    // that same emoji, and the picks after it are switches again.
    const gitlab = await ext.openSite(session.context, ext.gitlabUrl(), { requireHost: false });
    if (await ext.firstMountedKey(gitlab, "gitlab:")) {
      for (const glyph of glyphs.slice(GITHUB_CLICKS, GITHUB_CLICKS + GITLAB_CLICKS)) {
        await pickEmoji(gitlab, glyph);
        clicks.push({ emoji: glyph, host: hostOf(ext.gitlabUrl()) });
        lastPicks.gitlab = glyph;
      }
    }

    await expectBurstSettles(session.context, () => responses.slice(sinceBurst), lastPicks);

    // Newest first, one row per click: a lost reaction shifts an older row into
    // the compared window, a doubled one repeats a glyph.
    expect(await topHistoryRows(session.context, clicks.length), "History should list every click of the burst, newest first").toEqual([...clicks].reverse());
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

test("a burst that meets a 429 waits out its Retry-After and still lands the last pick", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_SIGNIN);
  test.setTimeout(BURST_TIMEOUT_MS);
  const session = await ext.launchSession();
  const responses = watchVoteResponses(session.context);
  try {
    // Its own account, so this case's votes never interact with the shared one.
    const page = await ext.signedInGithubPage(session.context, ext.authAccount("burst-limit"));
    await resetTarget(session.context, page);

    const glyphs = await pickerGlyphs(page, GITHUB_CLICKS);
    const sinceBurst = responses.length;
    // The burst's first vote is refused the way the server refuses an account over
    // its minute budget; every later one goes to the server.
    let refused = false;
    await session.context.route("**/v2/react", async (route) => {
      if (refused) {
        await route.fallback();
        return;
      }
      refused = true;
      await route.fulfill({
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(REFUSAL_RETRY_AFTER_SEC), "cache-control": "no-store" },
        body: JSON.stringify({ error: "rate_limited", scope: "account" }),
      });
    });

    const host = hostOf(ext.githubUrl());
    const clicks: ReactionRow[] = [];
    for (const glyph of glyphs) {
      await pickEmoji(page, glyph);
      clicks.push({ emoji: glyph, host });
    }

    await expectBurstSettles(session.context, () => responses.slice(sinceBurst), { github: glyphs[glyphs.length - 1] ?? "" });

    const seen = responses.slice(sinceBurst);
    const firstRefusal = refusedVotes(seen)[0];
    expect(firstRefusal, "the burst's first vote should have met the 429").toBeDefined();
    if (!firstRefusal) return;
    // The account waits out the Retry-After: no vote of it answers sooner.
    const nextAnswer = seen.find((r) => r.at > firstRefusal.at);
    expect(nextAnswer, "a vote should follow the 429").toBeDefined();
    expect((nextAnswer?.at ?? 0) - firstRefusal.at, `the next vote should wait out the ${REFUSAL_RETRY_AFTER_SEC} s Retry-After`).toBeGreaterThanOrEqual(REFUSAL_RETRY_AFTER_SEC * 1000);

    expect(await topHistoryRows(session.context, clicks.length), "History should still list every click of the burst, newest first").toEqual([...clicks].reverse());
  } finally {
    await session.context.unroute("**/v2/react").catch(() => {});
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});
