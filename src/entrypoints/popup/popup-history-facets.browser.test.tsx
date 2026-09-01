// SPDX-License-Identifier: GPL-3.0-or-later
//
// The History tab's emoji facet strip. It reads as a per-emoji tally, so a silently
// truncated one under-reports the account's own reactions - the shape that made a user
// report reactions as "not counted" when every row was in fact stored. What matters here
// is that nothing is cut without a way to see it, and that expanding shows ALL of it.
import { h } from "preact";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AUTH_KEY } from "../../shared/auth-session";
import { mountContainer, renderAndSettle, unmountContainer } from "../../test/browser-harness";
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
