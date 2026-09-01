// SPDX-License-Identifier: GPL-3.0-or-later
//
// Auto-press native buttons (the opt-in setting): a positive pick presses the
// site's Like/upvote/star, a negative pick its dislike/downvote, a Facebook exact
// match sets the matching flyout reaction - and un-react releases only what
// the extension itself pressed. UNLIKE the rest of this suite these flows are
// NOT platform-passive: they press real native controls under the signed-in
// account, and every case reverts its press before finishing.
//
// GitLab, GitHub, Threads and Instagram are here for a second reason: none of
// them exposes a generic pressed state, so the client reads the star icon, the
// flipped Star label, the heart's paint, or the localized heart label instead.
// Those reads break silently when a site restyles, and only a live page catches
// it - which is why the probes below inject the SHIPPED readers (imported from
// src/adapters and serialized into the page): a drifted helper fails here
// instead of a stale copy silently passing.
//
// Extra setup on top of the suite's README: turn ON "Auto-press original
// buttons" in the Emojery popup for the connected Chrome. The first
// assertion fails with that instruction when the press never happens.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FB_REACTION_MENU_ARIA, FB_REMOVE_RE, FB_STEMS, fbLikeLabelPressed } from "../../src/adapters/facebook";
import { githubStarLabelPressed } from "../../src/adapters/github";
import { gitlabIconName, gitlabStarIconPressed } from "../../src/adapters/gitlab";
import { IG_STEMS, IG_UNLIKE_RE, igLikeLabelPressed } from "../../src/adapters/instagram";
import { isPaintedFill, THREADS_NON_LIKE_ICON_PATH_PREFIXES } from "../../src/adapters/threads";
import type { Bridge } from "./bridge";
import { bridgeFixture, GRID_ITEM_SELECTOR, gotoSettled, openPickerState, SETUP_HOOK_TIMEOUT_MS, siteAuthEnabled, waitForHost } from "./harness";
import { ownReactionProbe } from "./probes";
import { authContentUrl } from "./scenarios";

const fx = bridgeFixture();

// Click the grid emoji whose glyph matches exactly (the glyph stays in
// textContent even in sprite mode - see EmojiImg).
async function pickEmoji(b: Bridge, emoji: string): Promise<void> {
  await b.act(`await page.locator(${JSON.stringify(GRID_ITEM_SELECTOR)}).filter({ hasText: ${JSON.stringify(emoji)} }).filter({ visible: true }).first().click({ timeout: 8000 });`);
  await b.waitMs(400);
}

// Open the picker and toggle the currently selected emoji off. Returns whether
// a reaction was actually there to remove; an empty picker is NOT an error -
// the cleanup below runs it on posts that may already be clean, and the
// `finally` of a case that failed before reacting reaches it too. (The former
// unconditional click failed the run with a locator timeout, which then hid
// the real assertion behind a cleanup error.)
// ONLY a locator timeout means "there was nothing selected". A dead tab or a
// bridge -32001 must NOT read as a clean picker - that once turned a broken
// connection into a silently green cleanup.
const isLocatorTimeout = (err: unknown): boolean => /Timeout \d+ms exceeded/i.test(String(err));

// Two passes, the same shape e2e/lib/reaction-surface.ts `clearReaction` runs:
// `mine` arrives with the counts fetch, so a picker opened right after mount can
// render an unpressed grid while the reaction is still on its way. One pass then
// clears nothing, reads as "there was nothing selected", and the case reacts onto
// a target that already carries our emoji - the exact state below that this suite
// cannot survive. The second pass runs only while the trigger is still active.
async function unReact(b: Bridge): Promise<boolean> {
  let removed = false;
  for (let pass = 0; pass < 2; pass++) {
    await openPickerState(b);
    const clicked = await b.act(`await page.locator('${GRID_ITEM_SELECTOR}[aria-pressed="true"]').filter({ visible: true }).first().click({ timeout: 4000 });`).then(
      () => true,
      (err: unknown) => {
        if (!isLocatorTimeout(err)) throw err;
        return false;
      },
    );
    if (clicked) removed = true;
    await b.press("Escape");
    await b.waitMs(600);
    // The optimistic clear lands only after the content script's round-trip to
    // the service worker, so poll before calling the pass wasted.
    if (!(await pollState(b, ownReactionProbe(), false, 3_000))) break;
  }
  return removed;
}

// Every case needs a target with NO Emojery reaction of ours on it:
// re-picking an emoji that is already set is a no-op, so auto-press would have
// nothing to do and the case would fail as "native control was not pressed".
// A previous run that died mid-case leaves exactly that state, which is what
// made this suite unable to survive its own rerun.
async function clearOwnReaction(b: Bridge): Promise<void> {
  if (await unReact(b)) await b.waitMs(1_200);
}

// Poll a page-context probe until it returns `want` (or time runs out);
// returns the last observed value so the assertion message shows reality.
async function pollState<T>(b: Bridge, probe: string, want: T, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const last = await b.evaluate<T>(probe);
    if (last === want || Date.now() >= deadline) return last;
    await b.waitMs(400);
  }
}

const YT_LIKE = `return document.querySelector('like-button-view-model button')?.getAttribute('aria-pressed') ?? null;`;
const YT_DISLIKE = `return document.querySelector('dislike-button-view-model button')?.getAttribute('aria-pressed') ?? null;`;
const REDDIT_DOWN = `return document.querySelector('shreddit-post')?.shadowRoot?.querySelector('button[downvote]')?.getAttribute('aria-pressed') ?? null;`;

// Serialize a shipped function / regex into page-context source. `String(fn)`
// yields the transpiled JS body, so the probe executes byte-for-byte what the
// extension ships (closured module constants are re-declared alongside).
const fnSrc = (fn: (...args: never[]) => unknown) => String(fn);
const reSrc = (re: RegExp) => re.toString();

// Scoping every probe to OUR OWN mounted host, not to the document. Captured
// live: a Facebook permalink exposes 26 Like-labelled buttons (every comment
// has one) and an Instagram permalink 16 hearts, while a Threads page's first
// path-unmatched icon is the site LOGO - so "first recognized control in
// document order" measured a comment or a logo and reported a press that never
// concerned the post under test. The adapter anchored our host inside the
// post's action row, so walking up from it finds exactly the control the
// adapter bound to. Emitted as page-context source, so it stays self-contained.
const SCOPE_TO_HOST_ROW = `
  const hostRow = (matches) => {
    const host = document.querySelector('.khasky-emojery-host');
    if (!host) return null;
    let node = host.parentElement;
    for (let depth = 0; node && depth < 10; depth++) {
      const hit = matches(node);
      if (hit) return hit;
      node = node.parentElement;
    }
    return null;
  };`;

// 'plain' = no native reaction, 'reacted' = one is set, null = not found. The
// chevron's "Change ... reaction" and the "Like: 3 people" count summary are
// rejected exactly as the adapter rejects them (the summary sits in the same
// row as the real button, so scoping alone does not exclude it).
const FB_STATE = `
  ${SCOPE_TO_HOST_ROW}
  const FB_REMOVE_RE = ${reSrc(FB_REMOVE_RE)};
  const FB_STEMS = { like: ${reSrc(FB_STEMS.like)} };
  const FB_REACTION_MENU_ARIA = ${reSrc(FB_REACTION_MENU_ARIA)};
  const fbLikeLabelPressed = ${fnSrc(fbLikeLabelPressed)};
  const readLabel = (b) => (b.getAttribute('aria-label') || '').trim();
  const btn = hostRow((row) => [...row.querySelectorAll('div[role="button"], span[role="button"]')].find((b) => {
    const l = readLabel(b);
    if (!l || /suggested/i.test(l) || FB_REACTION_MENU_ARIA.test(l) || /:\\s*\\d/.test(l)) return false;
    return fbLikeLabelPressed(l) !== null;
  }));
  if (!btn) return null;
  return fbLikeLabelPressed(readLabel(btn)) ? 'reacted' : 'plain';`;

// GitLab exposes no aria-pressed and keeps `data-testid="star-button"` in both
// states - only the icon flips, `star-o` outline vs filled `star`. Both the
// icon-name read and the mapping are the shipped ones.
const GITLAB_STAR = `
  const gitlabIconName = ${fnSrc(gitlabIconName)};
  const gitlabStarIconPressed = ${fnSrc(gitlabStarIconPressed)};
  const btn = document.querySelector('button[data-testid="star-button"], button.star-btn');
  if (!btn) return null;
  const s = gitlabStarIconPressed(gitlabIconName(btn));
  return s === null ? null : String(s);`;

// GitHub's Star exposes no aria-pressed either; the flipped aria-label
// ("Star owner/repo" <-> "Unstar owner/repo") is the one signal, read by the
// shipped label reader over every labelled button (the Star button is the only
// one whose label it recognizes).
const GITHUB_STAR = `
  const githubStarLabelPressed = ${fnSrc(githubStarLabelPressed)};
  for (const btn of document.querySelectorAll('button[aria-label]')) {
    const s = githubStarLabelPressed((btn.getAttribute('aria-label') || '').trim());
    if (s !== null) return String(s);
  }
  return null;`;

// Threads localizes the heart's aria-label, so the state has to come from the
// paint: outline when unliked, filled when liked. Inside the host's row the
// heart is the one icon whose path matches none of the shipped non-Like
// prefixes; the paint decision is the shipped one.
const THREADS_LIKE = `
  ${SCOPE_TO_HOST_ROW}
  const OTHERS = ${JSON.stringify(THREADS_NON_LIKE_ICON_PATH_PREFIXES)};
  const isPaintedFill = ${fnSrc(isPaintedFill)};
  const pathOf = (svg) => (svg.querySelector('path')?.getAttribute('d') || '').replace(/\\s+/g, ' ');
  const heart = hostRow((row) => {
    const icons = [...row.querySelectorAll('svg')];
    // The row must actually be the action row: it carries the Reply icon.
    if (!icons.some((svg) => pathOf(svg).startsWith(OTHERS[0]))) return null;
    return icons.find((svg) => { const d = pathOf(svg); return d && !OTHERS.some((p) => d.startsWith(p)); }) ?? null;
  });
  if (!heart) return null;
  const s = isPaintedFill(getComputedStyle(heart).fill);
  return s === null ? null : String(s);`;

// Instagram's heart carries a localized aria-label whose RU unlike CONTAINS the
// like stem - the shipped negation-first reader is exactly what this probe
// keeps honest. Scoped to the host's row: a permalink's comments each carry
// their own "Нравится" heart, and the first in document order is not the post's.
const IG_LIKE = `
  ${SCOPE_TO_HOST_ROW}
  const IG_UNLIKE_RE = ${reSrc(IG_UNLIKE_RE)};
  const IG_STEMS = { like: ${reSrc(IG_STEMS.like)} };
  const igLikeLabelPressed = ${fnSrc(igLikeLabelPressed)};
  const heart = hostRow((row) => [...row.querySelectorAll('svg[aria-label]')].find((svg) => igLikeLabelPressed((svg.getAttribute('aria-label') || '').trim()) !== null) ?? null);
  if (!heart) return null;
  const s = igLikeLabelPressed((heart.getAttribute('aria-label') || '').trim());
  return s === null ? null : String(s);`;

// A press that never lands has two very different causes: the opt-in setting
// is off (nothing here works, and no amount of debugging helps), or one site
// broke (everything else still works). The bridge cannot read the setting - it
// has no access to chrome-extension:// pages - but it CAN tell the two apart by
// outcome: once ANY site has pressed, the setting is proven on and every later
// failure belongs to that site alone. The first case to run (YouTube, the most
// reliable surface) therefore doubles as the gate.
const ENABLE_HINT = "native control was not pressed - turn ON 'Auto-press original buttons' in the Emojery popup of the connected Chrome, then re-run `pnpm test:e2e:siteauth:autopress` (nothing else in this file can pass while it is off).";
let anyPressLanded = false;

function recordPressLanded(): void {
  anyPressLanded = true;
}

// Message for a case that failed AFTER another site already pressed: the
// setting is not the suspect any more, so don't send the reader chasing it.
function siteSpecificHint(site: string, pick: string): string {
  return anyPressLanded ? `${site} ${pick}: the auto-press setting is ON (another site pressed in this run), so this is a ${site}-specific failure - not a setup problem.` : `${site} ${pick}: ${ENABLE_HINT}`;
}

// The GitLab, GitHub, Threads and Instagram cases are one flow: start from an
// unpressed native control, pick 👍, poll the shipped reader to "pressed", and
// prove un-react releases it. Only the probe and the wording differ, so the
// four tests share this driver; YouTube (vote switch), Reddit (downvote) and
// Facebook (flyout) keep their own.
async function expectPickPressesAndUnReactReleases(site: "gitlab" | "github" | "threads" | "instagram", probe: string, msg: { host: string; noControl: string; alreadyPressed: string; release: string }): Promise<void> {
  const b = fx.need();
  await gotoSettled(b, authContentUrl(site), 4_000);
  expect(await waitForHost(b, site, 12_000), msg.host).toBeGreaterThan(0);
  await clearOwnReaction(b);

  const before = await b.evaluate<string | null>(probe);
  expect(before, msg.noControl).toBeTruthy();
  expect(before, msg.alreadyPressed).toBe("false");

  try {
    const picker = await openPickerState(b);
    expect(picker.gridVisible, `${site}: Emojery picker did not open (extension signed out?)`).toBe(true);
    await pickEmoji(b, "👍");
    expect(await pollState(b, probe, "true", 8_000), siteSpecificHint(site, "👍")).toBe("true");
    recordPressLanded();
  } finally {
    await unReact(b);
  }
  expect(await pollState(b, probe, "false", 8_000), msg.release).toBe("false");
}

// No bridge needed: the serialized shipped readers must stay valid page-context
// source (a TS-only construct or broken regex serialization fails here, before
// anyone runs the browser flows).
describe("auto-press probe serialization", () => {
  test("every shipped-reader probe compiles", () => {
    for (const probe of [FB_STATE, GITLAB_STAR, GITHUB_STAR, THREADS_LIKE, IG_LIKE]) {
      expect(() => new Function(probe)).not.toThrow();
    }
  });
});

(siteAuthEnabled() ? describe : describe.skip)("site-auth: auto-press native buttons", () => {
  beforeAll(fx.setup, SETUP_HOOK_TIMEOUT_MS);
  afterAll(fx.teardown);

  test("youtube: positive presses Like, negative flips to Dislike, un-react releases", async () => {
    const b = fx.need();
    await gotoSettled(b, authContentUrl("youtube"), 4_000);
    expect(await waitForHost(b, "youtube", 12_000), "youtube: no Emojery host - log into YouTube / check the test video").toBeGreaterThan(0);
    await clearOwnReaction(b);

    try {
      let picker = await openPickerState(b);
      expect(picker.gridVisible, "youtube: Emojery picker did not open (extension signed out?)").toBe(true);
      await pickEmoji(b, "👍");
      expect(await pollState(b, YT_LIKE, "true", 8_000), `youtube 👍: ${ENABLE_HINT}`).toBe("true");
      recordPressLanded();

      picker = await openPickerState(b);
      expect(picker.gridVisible).toBe(true);
      await pickEmoji(b, "👎");
      expect(await pollState(b, YT_DISLIKE, "true", 8_000), "youtube 👎: dislike was not pressed on a negative pick").toBe("true");
      // YouTube itself releases the opposite button on a vote switch.
      expect(await pollState(b, YT_LIKE, "false", 4_000), "youtube: switching to a negative pick should release Like").toBe("false");
    } finally {
      await unReact(b);
    }
    expect(await pollState(b, YT_DISLIKE, "false", 8_000), "youtube: un-react must release the auto-pressed Dislike").toBe("false");
    expect(await b.evaluate<string | null>(YT_LIKE), "youtube: nothing may stay pressed after un-react").toBe("false");
  });

  test("reddit: negative presses downvote, un-react releases it", async () => {
    const b = fx.need();
    await gotoSettled(b, authContentUrl("reddit"), 4_000);
    expect(await waitForHost(b, "reddit", 12_000), "reddit: no Emojery host - log into Reddit / check the test post").toBeGreaterThan(0);
    await clearOwnReaction(b);

    try {
      const picker = await openPickerState(b);
      expect(picker.gridVisible, "reddit: Emojery picker did not open (extension signed out?)").toBe(true);
      await pickEmoji(b, "👎");
      expect(await pollState(b, REDDIT_DOWN, "true", 8_000), siteSpecificHint("reddit", "👎")).toBe("true");
      recordPressLanded();
    } finally {
      await unReact(b);
    }
    expect(await pollState(b, REDDIT_DOWN, "false", 8_000), "reddit: un-react must release the auto-pressed downvote").toBe("false");
  });

  // Star state is the only signal GitLab gives, and it is read from the icon
  // rather than an aria attribute - so this case is what keeps that read honest
  // against a GitLab icon rename.
  test("gitlab: positive presses Star, un-react releases it", () =>
    expectPickPressesAndUnReactReleases("gitlab", GITLAB_STAR, {
      host: "gitlab: no Emojery host - log into GitLab / check the test project",
      noControl: "gitlab: no readable Star button - signed out shows a starrers link instead",
      alreadyPressed: "gitlab: the test project is already starred - unstar it manually first",
      release: "gitlab: un-react must release the auto-pressed Star",
    }));

  // GitHub's pressed state lives only in the flipped aria-label (no
  // aria-pressed, no /unstar form, same data-testid in both states) - this case
  // keeps that label read honest against a Primer redesign.
  test("github: positive presses Star, un-react releases it", () =>
    expectPickPressesAndUnReactReleases("github", GITHUB_STAR, {
      host: "github: no Emojery host - log into GitHub / check the test repo",
      noControl: "github: no readable Star button found (signed out?)",
      alreadyPressed: "github: the test repo is already starred - unstar it manually first",
      release: "github: un-react must release the auto-pressed Star",
    }));

  // Threads reads the like state from the heart's paint, not its localized
  // label; this case proves that read still works on a live, localized feed.
  test("threads: positive presses Like, un-react releases it", () =>
    expectPickPressesAndUnReactReleases("threads", THREADS_LIKE, {
      host: "threads: no Emojery host - log into Threads / check the test post",
      noControl: "threads: no readable Like heart found on the post",
      alreadyPressed: "threads: the test post is already liked - unlike it manually first",
      release: "threads: un-react must release the auto-pressed Like",
    }));

  // Instagram's liked state is read from the heart's LOCALIZED aria-label, and
  // the RU unlike contains the like stem - this case proves the shipped
  // negation-first read on a live, localized page.
  test("instagram: positive presses Like, un-react releases it", () =>
    expectPickPressesAndUnReactReleases("instagram", IG_LIKE, {
      host: "instagram: no Emojery host - log into Instagram / check the test post",
      noControl: "instagram: no readable Like heart found on the post",
      alreadyPressed: "instagram: the test post is already liked - unlike it manually first",
      release: "instagram: un-react must release the auto-pressed Like",
    }));

  // Timeout above the file default: reaching the press at all means crossing a
  // logged-in permalink that hydrates ~66s (an abandoned run here is what left
  // the stale fb:love record decideNativeTrigger now re-drives past).
  test("facebook: ❤️ sets the native Love via the flyout, un-react clears it", async () => {
    const b = fx.need();
    await gotoSettled(b, authContentUrl("facebook"), 4_000);
    expect(await waitForHost(b, "facebook", 60_000), "facebook: no Emojery host - log into Facebook / check the test post").toBeGreaterThan(0);
    await clearOwnReaction(b);

    const before = await b.evaluate<string | null>(FB_STATE);
    expect(before, "facebook: no Like control found near the post").toBeTruthy();
    expect(before, "facebook: the test post already carries a native reaction - clear it manually first").toBe("plain");

    try {
      const picker = await openPickerState(b);
      expect(picker.gridVisible, "facebook: Emojery picker did not open (extension signed out?)").toBe(true);
      await pickEmoji(b, "❤️");
      // Flyout path: prewarmed while the picker was open, cold retry otherwise.
      expect(await pollState(b, FB_STATE, "reacted", 12_000), siteSpecificHint("facebook", "❤️->Love")).toBe("reacted");
      recordPressLanded();
    } finally {
      await unReact(b);
    }
    expect(await pollState(b, FB_STATE, "plain", 8_000), "facebook: un-react must clear the auto-set native reaction").toBe("plain");
  }, 300_000);
});
