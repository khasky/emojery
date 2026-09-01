// SPDX-License-Identifier: GPL-3.0-or-later
//
// What a user gets when they react FAST, reported as "I placed a lot of
// reactions quickly and not all of them were counted". Per click, end to end: a
// burst the backend accepts must reach History in full (right emoji, right target,
// right order); one it refuses must leave the refused clicks uncounted in that
// window and still not lose them - the durable queue re-sends them, so History
// again holds exactly one row per click.
//
// Nothing is simulated: the real picker on the login-free GitHub/GitLab surfaces,
// the real (staging) backend, the result read from the extension's own popup. The
// wire record below is the black-box answer to "was it counted" - the queue
// flushes from the service worker, whose requests context-level events see too.
import { type BrowserContext, type ElementHandle, expect, type Page, test } from "@playwright/test";
import * as ext from "./lib/extension";
import { pollForValue } from "./lib/picker-probes";
import { openHistoryTab } from "./lib/popup-probes";
import { GRID_ITEM_SELECTOR } from "./lib/selectors";

// Tracing OFF for this file, on every attempt. The snapshotter re-serializes the
// picker's ~600-button grid after each action, which costs seconds per pick (the
// measurement behind playwright.config.ts's `on-first-retry` default): a burst
// that slow never draws a refusal at all, so a traced run of the refused case
// would go red for a reason that is purely the harness. Failure screenshots are
// unaffected.
test.use({ trace: "off" });

const REQUIRES_OTP = ext.otpSkipReason("the reaction-burst accounting checks");

// Whole file signs in through auth.html, which Playwright Firefox cannot reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);

// A burst plus the popup round-trip. The refused case additionally waits for the
// refused clicks to be re-sent, so it gets its own, longer budget.
const BURST_TIMEOUT_MS = Number(process.env.E2E_BURST_TEST_TIMEOUT_MS ?? 300_000);
const REFUSED_BURST_TIMEOUT_MS = Number(process.env.E2E_REFUSED_BURST_TEST_TIMEOUT_MS ?? 600_000);
const DRAIN_TIMEOUT_MS = 240_000;

// A clean burst: this case is about the accounting, so it stays modest and
// leaves room for the un-react that resets the target first.
const GITHUB_CLICKS = Number(process.env.E2E_BURST_CLEAN_GITHUB ?? 8);
const GITLAB_CLICKS = Number(process.env.E2E_BURST_CLEAN_GITLAB ?? 2);

// Shape of the refused case: clicks per round, how many rounds, and how long a
// round is staggered from the one before it. Configured, never defaulted in the
// tree. Unset (or non-positive) => the refused case skips, like the OTP gate above.
const MAX_BURST_CLICKS = Number(process.env.E2E_BURST_MAX_CLICKS);
const BURST_ROUNDS = Number(process.env.E2E_BURST_ROUNDS);
const BURST_ROUND_MS = Number(process.env.E2E_BURST_ROUND_MS);
const burstShapeConfigured = (): boolean => [MAX_BURST_CLICKS, BURST_ROUNDS, BURST_ROUND_MS].every((value) => Number.isFinite(value) && value > 0);
const REQUIRES_BURST_SHAPE = "Set E2E_BURST_MAX_CLICKS, E2E_BURST_ROUNDS and E2E_BURST_ROUND_MS in .env.e2e.local (see .env.e2e.example) to run the refused-burst accounting check.";

interface VoteResponse {
  status: number;
  /** `retry-after` seconds, present on a refusal. */
  retryAfterSec: number | null;
  at: number;
}

// Every vote POST the extension makes, in wire order, without reaching into the
// extension's own storage for it.
function watchVoteResponses(context: BrowserContext): VoteResponse[] {
  const seen: VoteResponse[] = [];
  context.on("response", (response) => {
    if (!response.url().includes("/reactions/vote")) return;
    const retryAfter = Number(response.headers()["retry-after"]);
    seen.push({
      status: response.status(),
      retryAfterSec: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
      at: Date.now(),
    });
  });
  return seen;
}

const countedVotes = (responses: VoteResponse[]): number => responses.filter((r) => r.status === 200).length;
const refusedVotes = (responses: VoteResponse[]): VoteResponse[] => responses.filter((r) => r.status === 429);

// The grid lives in an OPEN shadow root, so reading it from that root directly is
// what keeps a pick cheap: the document-wide shadow-piercing walk (lib/probe-src.ts)
// costs seconds per call on a heavy page like a big repo header, and per click
// that is what decides whether the refused case can draw a refusal at all.
const PICKER_GRID_ITEMS_SRC = `const pickerGridItems = () => {
  const out = [];
  for (const host of document.querySelectorAll(".khasky-emojery-overlay-host, .khasky-emojery-host")) {
    const root = host.shadowRoot;
    if (!root) continue;
    for (const item of root.querySelectorAll(".khasky-emojery-grid-item")) out.push(item);
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
// never draws a refusal, which is the whole point of the refused case
// below. Enter on a focused <button> is the trusted activation the picker
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

// The glyphs the picker actually renders, read from the open tray: a hardcoded
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

// Successive rounds are staggered; the stagger is configured, not derived.
async function waitForRoundStart(page: Page): Promise<void> {
  await page.waitForTimeout(BURST_ROUND_MS);
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
    const rows = await popup.locator(".history li").evaluateAll((items) =>
      items.map((li) => ({
        emoji: (li.querySelector(".history-emoji")?.textContent ?? "").trim(),
        href: li.querySelector("a.history-link")?.getAttribute("href") ?? "",
      })),
    );
    return rows.slice(0, count).map((row) => ({ emoji: row.emoji, host: hostOf(row.href) }));
  } finally {
    await popup.close().catch(() => {});
  }
}

// An un-react is a vote like any other: let it land BEFORE the burst so it
// counts into neither the burst nor its History rows.
async function resetTarget(context: BrowserContext, page: Page): Promise<void> {
  const flushed = ext.watchNextVoteFlush(context);
  if (await ext.clearReaction(page)) await flushed();
}

test("a fast burst the backend accepts is counted in full and every click shows in History", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  test.setTimeout(BURST_TIMEOUT_MS);
  const session = await ext.launchSession();
  const responses = watchVoteResponses(session.context);
  try {
    const github = await ext.signedInGithubPage(session.context);
    await resetTarget(session.context, github);

    const glyphs = await pickerGlyphs(github, GITHUB_CLICKS + GITLAB_CLICKS);
    const sinceBurst = responses.length;
    const clicks: ReactionRow[] = [];
    for (const glyph of glyphs.slice(0, GITHUB_CLICKS)) {
      await pickEmoji(github, glyph);
      clicks.push({ emoji: glyph, host: hostOf(ext.githubUrl()) });
    }

    // A second target, because the report is about reactions spread over
    // different pages, not one page reacted to repeatedly. GitLab is skipped
    // rather than failed when its header does not mount - that is a site-side
    // condition the placement suites own.
    // Not reset like the first target: an un-react here would land INSIDE the
    // counted burst as a vote and a row of its own. A reaction left on GitLab by
    // an earlier run at worst turns one pick into a toggle-off, which is still
    // one vote and one row carrying that same emoji.
    const gitlab = await ext.openSite(session.context, ext.gitlabUrl(), { requireHost: false });
    if (await ext.firstMountedKey(gitlab, "gitlab:")) {
      for (const glyph of glyphs.slice(GITHUB_CLICKS, GITHUB_CLICKS + GITLAB_CLICKS)) {
        await pickEmoji(gitlab, glyph);
        clicks.push({ emoji: glyph, host: hostOf(ext.gitlabUrl()) });
      }
    }

    await expect
      .poll(() => countedVotes(responses.slice(sinceBurst)), {
        message: `every one of the ${clicks.length} clicks should reach the backend and be counted`,
        timeout: DRAIN_TIMEOUT_MS,
        intervals: [1_000],
      })
      .toBe(clicks.length);

    // Newest first, one row per click: a lost reaction shifts an older row into
    // the compared window, a doubled one repeats a glyph.
    expect(await topHistoryRows(session.context, clicks.length), "History should list every click of the burst, newest first").toEqual([...clicks].reverse());
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

test("a burst the backend refuses is re-sent - no reaction is lost", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  test.skip(!burstShapeConfigured(), REQUIRES_BURST_SHAPE);
  test.setTimeout(REFUSED_BURST_TIMEOUT_MS);
  const session = await ext.launchSession();
  const responses = watchVoteResponses(session.context);
  try {
    const page = await ext.signedInGithubPage(session.context);
    await resetTarget(session.context, page);

    const glyphs = await pickerGlyphs(page, MAX_BURST_CLICKS * BURST_ROUNDS);
    const sinceBurst = responses.length;
    const host = hostOf(ext.githubUrl());
    const clicks: ReactionRow[] = [];
    for (let round = 0; round < BURST_ROUNDS && refusedVotes(responses.slice(sinceBurst)).length === 0; round += 1) {
      await waitForRoundStart(page);
      const roundEnds = Date.now() + BURST_ROUND_MS;
      for (const glyph of glyphs.slice(clicks.length, clicks.length + MAX_BURST_CLICKS)) {
        if (refusedVotes(responses.slice(sinceBurst)).length > 0 || Date.now() >= roundEnds) break;
        await pickEmoji(page, glyph);
        clicks.push({ emoji: glyph, host });
      }
    }

    // The click count alone cannot say why no refusal came: a burst that never
    // reached the wire and one the backend accepted in full look identical from
    // it. Report what the wire actually carried, and over how long.
    const wireSummary = (): string => {
      const seen = responses.slice(sinceBurst);
      const spanSec = seen.length > 1 ? Math.round((seen[seen.length - 1]!.at - seen[0]!.at) / 100) / 10 : 0;
      const byStatus: Record<number, number> = {};
      for (const r of seen) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      return `${clicks.length} clicks fired, ${seen.length} vote request(s) over ${spanSec}s, statuses ${JSON.stringify(byStatus)}`;
    };

    // Clicking outruns the queue: each vote is a serial round trip, so a burst is
    // still draining long after the last press - measured 40 clicks against 3
    // requests on the wire when the loop ended. The refusal therefore lands during
    // the DRAIN, and asserting the instant the loop exits only ever saw the first
    // few sends. Wait for the wire to settle one way: a refusal, or the whole
    // burst counted (which is the real "the backend accepted all of it" failure).
    await expect
      .poll(() => refusedVotes(responses.slice(sinceBurst)).length > 0 || countedVotes(responses.slice(sinceBurst)) >= clicks.length, {
        message: `the burst should reach the wire (${wireSummary()})`,
        timeout: DRAIN_TIMEOUT_MS,
        intervals: [2_000],
      })
      .toBe(true);

    const firstRefusal = refusedVotes(responses.slice(sinceBurst))[0];
    expect(firstRefusal, `the backend should refuse part of the burst (${wireSummary()})`).toBeDefined();
    if (!firstRefusal) return;
    expect(firstRefusal.retryAfterSec, "a refusal should tell the client when to retry").not.toBeNull();

    // The refusal is real accounting: when the backend said no, fewer clicks
    // had been counted than the user had made.
    const countedAtRefusal = responses.slice(sinceBurst).filter((r) => r.status === 200 && r.at <= firstRefusal.at).length;
    expect(countedAtRefusal, "the refused clicks should not be counted").toBeLessThan(clicks.length);

    // ...and none of them is dropped: the durable queue re-sends the refused
    // clicks, so the whole burst is counted in the end.
    await expect
      .poll(() => countedVotes(responses.slice(sinceBurst)), {
        message: `all ${clicks.length} clicks should be counted once the queue re-sends the refused ones`,
        timeout: DRAIN_TIMEOUT_MS,
        intervals: [2_000],
      })
      .toBe(clicks.length);

    expect(await topHistoryRows(session.context, clicks.length), "History should still list every click of the burst, newest first").toEqual([...clicks].reverse());
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});
