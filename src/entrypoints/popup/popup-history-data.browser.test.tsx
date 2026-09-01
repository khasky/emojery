// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Data section's stored-row count, which import REPLACES the history against.
// The count is what the confirm prints as "what you are about to lose", so the
// case that matters is a FAILED stats read: falling back to 0 there reads as
// "nothing to lose" - the one reassurance this dialog must never fabricate - and
// hiding Export on the same failure would strand the history it can't measure.
// The same confirm's danger surface and its screen-reader count line are pinned here too.
import { h } from "preact";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AUTH_KEY } from "../../shared/auth-session";
import type { RuntimeResponse } from "../../shared/messages";
import { mountContainer, renderAndSettle, requireEl, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim, makeLiveAuthSession } from "../../test/chrome-shim";
import { HistoryDataSection } from "./popup-history-data";
// The theme case reads resolved colours, so it needs the real sheet.
// @ts-expect-error side-effect css import, resolved by the browser-mode Vite server
import "./popup.css";

const LIVE_AUTH = makeLiveAuthSession();

const IMPORT_FILE = JSON.stringify({
  format: "emojery-history",
  schemaVersion: 1,
  reactions: [
    { site: "github", targetId: "a", targetUrl: "https://github.com/a", reaction: "👍", ts: 1 },
    { site: "github", targetId: "b", targetUrl: "https://github.com/b", reaction: "🎉", ts: 2 },
  ],
});

let chromeShim: ChromeShimHandle;
let container: HTMLDivElement;

function install(statsReply: RuntimeResponse): void {
  chromeShim = installChromeShim({
    local: { [AUTH_KEY]: LIVE_AUTH },
    onMessage: (msg) => ((msg as { type?: string }).type === "history:stats" ? statsReply : undefined),
  });
}

// The first stats read lands in an effect, so every assertion waits for the
// section to leave its "still loading" shape (Import is the row always present).
const mountAndSettle = () => renderAndSettle(container, h(HistoryDataSection, {}), ".data-file");

async function armImportConfirm(): Promise<void> {
  const input = requireEl<HTMLInputElement>(container, ".data-file");
  await userEvent.upload(input, new File([IMPORT_FILE], "history.json", { type: "application/json" }));
  await vi.waitFor(() => expect(container.querySelector(".import-confirm-count")).not.toBeNull());
}

function confirmCountText(): string {
  return container.querySelector(".import-confirm-count")?.textContent?.trim() ?? "";
}

/** The count as assistive tech gets it - the visible line is arrow-only and aria-hidden. */
function confirmCountAnnounced(): string {
  return container.querySelector(".import-confirm .sr-only")?.textContent?.trim() ?? "";
}

/** Two action rows = Export is offered, one = Export is hidden. */
function actionRowCount(): number {
  return container.querySelectorAll(".row.arow").length;
}

beforeEach(() => {
  container = mountContainer();
});

afterEach(() => {
  unmountContainer(container);
  chromeShim?.uninstall();
});

it("a known count is offered for export and printed in the replace confirm", async () => {
  install({ type: "history:stats", authed: true, stats: { total: 5, bySite: {}, byEmoji: {} } });
  await mountAndSettle();

  await vi.waitFor(() => expect(actionRowCount()).toBe(2));
  await armImportConfirm();
  expect(confirmCountText()).toBe("5 → 2");
  // "5 right arrow 2" is not a figure anyone can act on: both counts have to reach
  // assistive tech as words, with the arrow itself kept out of the announcement.
  const announced = confirmCountAnnounced();
  expect(announced).toMatch(/\b5\b/);
  expect(announced).toMatch(/\b2\b/);
  expect(announced).not.toContain("→");
});

it("a known-empty account hides Export and still prints its zero", async () => {
  install({ type: "history:stats", authed: true, stats: { total: 0, bySite: {}, byEmoji: {} } });
  await mountAndSettle();

  await vi.waitFor(() => expect(actionRowCount()).toBe(1));
  await armImportConfirm();
  expect(confirmCountText()).toBe("0 → 2");
});

it("a FAILED stats read prints an unknown count and keeps Export reachable", async () => {
  install({ type: "error", code: "unavailable", message: "operation failed" });
  await mountAndSettle();

  await armImportConfirm();
  // Not "0 → 2": the read failed, so how much this import would replace is unknown.
  expect(confirmCountText()).toBe("? → 2");
  // And the failure must not be what removes the way to save that history first.
  expect(actionRowCount()).toBe(2);
});

// The panel is painted by the danger tokens, not a colour literal.
it("paints the confirm panel from the danger tokens, so it follows the theme", async () => {
  install({ type: "history:stats", authed: true, stats: { total: 5, bySite: {}, byEmoji: {} } });
  await mountAndSettle();
  await armImportConfirm();
  const panel = requireEl(container, ".import-confirm");

  const surface = () => {
    const style = getComputedStyle(panel);
    return { border: style.borderTopColor, background: style.backgroundColor };
  };
  const token = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const light = surface();
  document.documentElement.setAttribute("data-theme", "dark");
  const dark = surface();
  const darkBorderToken = token("--khasky-emojery-danger-border-strong");
  const darkFillToken = token("--khasky-emojery-danger-fill-subtle");
  // Restored before the asserts so a failure can't leave the page dark for the next test.
  document.documentElement.removeAttribute("data-theme");

  expect(dark.border).not.toBe(light.border);
  expect(dark.background).not.toBe(light.background);
  expect(dark.border).toBe(darkBorderToken);
  expect(dark.background).toBe(darkFillToken);
});
