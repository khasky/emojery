// SPDX-License-Identifier: GPL-3.0-or-later
//
// The History tab's emoji facet strip. It reads as a per-emoji tally, so a silently
// truncated one under-reports the account's own reactions - the shape that made a user
// report reactions as "not counted" when every row was stored. What matters here
// is that nothing is cut without a way to see it, and that expanding shows ALL of it.
//
// It is also a row of switches stacked on the site and date controls beside it, so the
// second block covers what happens when those are combined: the strip has to be counted
// under them, and a chip the combination empties has to stay clickable-off.
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AUTH_KEY } from "../../shared/auth-session";
import type { ReactionHistoryItem } from "../../shared/messages";
import { mountContainer, renderAndSettle, requireEl, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim, makeLiveAuthSession } from "../../test/chrome-shim";
import { HistoryView } from "./popup-history";

const LIVE_AUTH = makeLiveAuthSession();

// 12 distinct emoji, descending counts - two past the 10 the strip shows collapsed.
const EMOJI = ["👍", "😂", "🔥", "❤️", "🎉", "😮", "😢", "👏", "🤩", "🙏", "💯", "🤝"];
const BY_EMOJI = Object.fromEntries(EMOJI.map((em, i) => [em, EMOJI.length - i]));
const TOTAL = Object.values(BY_EMOJI).reduce((sum, n) => sum + n, 0);

const ROW = {
  userId: "u1",
  target: { site: "github" as const, targetId: "a", url: "https://github.com/a" },
  reaction: "👍",
  ts: Date.now(),
};

let chromeShim: ChromeShimHandle;
let container: HTMLDivElement;

function install(byEmoji: Record<string, number>): void {
  chromeShim = installChromeShim({
    local: { [AUTH_KEY]: LIVE_AUTH },
    onMessage: (msg) => {
      const type = (msg as { type?: string }).type;
      if (type === "history:stats") return { type: "history:stats", authed: true, stats: { total: TOTAL, bySite: { github: TOTAL }, byEmoji } };
      if (type === "history:page") return { type: "history:page", authed: true, items: [ROW], cursor: null };
      return undefined;
    },
  });
}

function chipCount(): number {
  return container.querySelectorAll(".facet-chip").length;
}

function toggle(): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(".facet-chips .linkish");
}

const mountAndSettle = () => renderAndSettle(container, h(HistoryView, {}), ".facet-chips");

beforeEach(() => {
  container = mountContainer();
});

afterEach(() => {
  unmountContainer(container);
  chromeShim?.uninstall();
});

it("shows the top 10 emoji and reveals every one of them on demand", async () => {
  install(BY_EMOJI);
  await mountAndSettle();

  expect(chipCount()).toBe(10);
  const more = toggle();
  expect(more).not.toBeNull();

  await userEvent.click(more!);
  await vi.waitFor(() => expect(chipCount()).toBe(EMOJI.length));
  // The counts are the whole distribution once expanded, not a top-N sample.
  expect([...container.querySelectorAll(".facet-chip-count")].reduce((sum, el) => sum + Number(el.textContent), 0)).toBe(TOTAL);

  await userEvent.click(toggle()!);
  await vi.waitFor(() => expect(chipCount()).toBe(10));
});

it("offers no toggle when the strip already shows every emoji", async () => {
  install(Object.fromEntries(EMOJI.slice(0, 10).map((em, i) => [em, 10 - i])));
  await mountAndSettle();

  expect(chipCount()).toBe(10);
  expect(toggle()).toBeNull();
});

describe("stacked with the site and date filters", () => {
  // The account behind the scripted answers: 4 github rows from today (👍 x3, 🔥) and one
  // reddit 🐸 from three days ago. Each reply is keyed by the filter its request carried,
  // so an unscripted key means the view asked for something other than what it is
  // showing - which is the bug itself.
  const REPLIES: Record<string, { rows: number; byEmoji: Record<string, number>; bySite: Record<string, number> }> = {
    "||": { rows: 5, byEmoji: { "👍": 3, "🔥": 1, "🐸": 1 }, bySite: { github: 4, reddit: 1 } },
    "reddit||": { rows: 1, byEmoji: { "🐸": 1 }, bySite: { github: 4, reddit: 1 } },
    "reddit|🐸|": { rows: 1, byEmoji: { "🐸": 1 }, bySite: { reddit: 1 } },
    // Today: the 🐸 is three days old, so both axes come back empty under it.
    "reddit|🐸|today": { rows: 0, byEmoji: {}, bySite: {} },
  };

  let asked: string[];

  function row(i: number): ReactionHistoryItem {
    return { userId: "u1", target: { site: "github", targetId: `t${i}`, url: `https://github.com/t${i}` }, reaction: "👍", ts: Date.now() - i * 1000 };
  }

  function installScripted(): void {
    asked = [];
    chromeShim = installChromeShim({
      local: { [AUTH_KEY]: LIVE_AUTH },
      onMessage: (msg) => {
        const m = msg as { type?: string; site?: string; emoji?: string; since?: number };
        if (m.type !== "history:stats" && m.type !== "history:page") return undefined;
        const key = `${m.site ?? ""}|${m.emoji ?? ""}|${m.since == null ? "" : "today"}`;
        const reply = REPLIES[key];
        if (!reply) throw new Error(`the view asked for an unscripted filter: ${key}`);
        if (m.type === "history:page") return { type: "history:page", authed: true, items: Array.from({ length: reply.rows }, (_, i) => row(i)), cursor: null };
        asked.push(key);
        return { type: "history:stats", authed: true, stats: { total: reply.rows, byEmoji: reply.byEmoji, bySite: reply.bySite } };
      },
    });
  }

  function chips(): { emoji: string; count: string; pressed: string | null }[] {
    return [...container.querySelectorAll<HTMLButtonElement>(".facet-chip")].map((el) => ({
      // The glyph itself: EmojiImg keeps it in the DOM under the sprite <img>, which is alt-less.
      emoji: requireEl(el, ".facet-chip-emoji").textContent ?? "",
      count: requireEl(el, ".facet-chip-count").textContent ?? "",
      pressed: el.getAttribute("aria-pressed"),
    }));
  }

  const siteSelect = () => requireEl<HTMLSelectElement>(container, 'select[aria-label="Filter by site"]');
  const rangeSelect = () => requireEl<HTMLSelectElement>(container, 'select[aria-label="Filter by time"]');

  beforeEach(installScripted);

  it("recounts the strip under the site filter instead of the whole history", async () => {
    await mountAndSettle();
    expect(chips().map((c) => c.emoji)).toEqual(["👍", "🔥", "🐸"]);

    await userEvent.selectOptions(siteSelect(), "reddit");

    // One reddit reaction, so one chip: the 👍 3 of github is not on offer here, and a
    // strip read off the whole history would still be promising it.
    await vi.waitFor(() => expect(chips()).toEqual([{ emoji: "🐸", count: "1", pressed: "false" }]));
    expect(asked.at(-1), "the aggregates must be asked for under the same filter as the rows").toBe("reddit||");
  });

  it("keeps a selection the date filter empties clickable-off", async () => {
    await mountAndSettle();
    await userEvent.selectOptions(siteSelect(), "reddit");
    await vi.waitFor(() => expect(chips()).toHaveLength(1));

    await userEvent.click(requireEl<HTMLButtonElement>(container, ".facet-chip"));
    await vi.waitFor(() => expect(chips()[0]?.pressed).toBe("true"));

    // Narrowing to today empties the list: the one reddit 🐸 is older than that. The two
    // selections that did it have to survive it - the chip at zero, still pressed, and the
    // site still on reddit - or the controls that clear the filter vanish with the rows.
    await userEvent.selectOptions(rangeSelect(), "today");
    await vi.waitFor(() => expect(container.querySelector(".history-nomatch")).not.toBeNull());
    expect(chips()).toEqual([{ emoji: "🐸", count: "0", pressed: "true" }]);
    expect(siteSelect().value).toBe("reddit");

    // And the way back out is still there.
    await userEvent.selectOptions(rangeSelect(), "all");
    await vi.waitFor(() => expect(container.querySelector(".history-nomatch")).toBeNull());
    expect(chips()).toEqual([{ emoji: "🐸", count: "1", pressed: "true" }]);
  });
});
