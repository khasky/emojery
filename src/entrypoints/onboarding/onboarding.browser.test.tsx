// SPDX-License-Identifier: GPL-3.0-or-later
//
// The onboarding page's self-ticking checklist: every step reflects a state the
// extension can observe on its own, the progress label follows, and the last
// tick fires the confetti exactly once.
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFETTI_SELECTOR, TAGLINE_SELECTOR } from "../../shared/page-dom";
import { SUPPORTED_SITES } from "../../shared/sites";
import { mountContainer, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim } from "../../test/chrome-shim";
import { App, CONFETTI_MS, PIN_POLL_MS } from "./main";

let shim: ChromeShimHandle;
let container: HTMLDivElement;

// The chrome shim carries no `action` API, which is exactly the "pin state
// unknowable" engine; a test that needs an answer installs this on top. The
// returned setter re-answers a later poll, standing in for the user pinning or
// unpinning the icon while the page is open.
function stubPinState(isOnToolbar: boolean): (next: boolean) => void {
  let current = isOnToolbar;
  (globalThis as { chrome?: { action?: unknown } }).chrome!.action = {
    getUserSettings: (cb?: (settings: { isOnToolbar: boolean }) => void) => {
      cb?.({ isOnToolbar: current });
      return Promise.resolve({ isOnToolbar: current });
    },
  };
  return (next: boolean) => {
    current = next;
  };
}

// The two latches the content script and the vote queue write; the page reads
// them once and then follows storage events.
function seedFlags(flags: { sawTrigger?: boolean; reacted?: boolean }): void {
  // Armed but unearned is what an open checklist looks like; `true` is the step earned.
  if (flags.sawTrigger !== undefined) shim.local.set("trigger_seen_v1", flags.sawTrigger);
  // The badge latch is armed at install and retired by the first queued vote.
  if (flags.reacted !== undefined) shim.local.set("onboarding_badge_v1", !flags.reacted);
}

function pushFlag(key: string, value: unknown): void {
  shim.local.set(key, value);
  shim.emitChanged("local", { [key]: { newValue: value } });
}

const steps = () => [...container.querySelectorAll(".step")];
const titles = () => steps().map((s) => s.querySelector("b")?.textContent);
const doneCount = () => container.querySelectorAll(".step.done").length;

function renderPage(): void {
  render(h(App, {}), container);
}

beforeEach(() => {
  shim = installChromeShim();
  container = mountContainer();
});

afterEach(() => {
  unmountContainer(container);
  shim.uninstall();
  vi.useRealTimers();
});

describe("onboarding checklist", () => {
  it("opens with only the install step ticked", async () => {
    stubPinState(false);
    seedFlags({ sawTrigger: false, reacted: false });
    renderPage();

    await expect.poll(() => steps().length).toBe(4);
    expect(doneCount()).toBe(1);
    expect(container.querySelector(".progress .label")?.textContent).toBe("1 of 4 done");
    // The tab strip carries the same count, in the UI language, so a backgrounded
    // page still says how far along it is.
    await expect.poll(() => document.title).toBe("Emojery — Onboarding 1/4");
    // The bar stays on its in-progress colour until the last tick.
    expect(container.querySelector(".progress.complete")).toBeNull();
  });

  it("lists every supported site by name inside the button step", async () => {
    stubPinState(false);
    renderPage();

    await expect.poll(() => container.querySelectorAll(".site-chips li:not(.more)").length).toBe(SUPPORTED_SITES.length);
    const chips = [...container.querySelectorAll(".site-chips li:not(.more)")].map((li) => li.textContent);
    expect(chips).toEqual(SUPPORTED_SITES.map((site) => site.label));
    // The roadmap line closes the row and is not a supported site.
    expect(container.querySelector(".site-chips li.more")?.textContent).toBe("250+ more sites on the roadmap");
    // The copy around the list carries no count to go stale when a site is added.
    expect(container.querySelector(TAGLINE_SELECTOR)?.textContent).not.toMatch(/\d/);
  });

  it("links Try it live at a logged-out-safe supported page with the react hint, inside the step it ticks", () => {
    renderPage();

    const cta = container.querySelector("a.primary");
    expect(cta?.getAttribute("href")).toBe("https://github.com/khasky/emojery#emojery-react");
    // The button is the way to do "Spot the button", so it lives in that step and not beside the brand.
    expect(cta?.closest(".step")?.querySelector("b")?.textContent).toBe("Spot the button");
  });

  it("drops the pin step where the browser cannot report pin state", async () => {
    seedFlags({ sawTrigger: false, reacted: false });
    renderPage();

    await expect.poll(() => steps().length).toBe(3);
    expect(titles()).not.toContain("Pin it");
    expect(container.querySelector(".progress .label")?.textContent).toBe("1 of 3 done");
    await expect.poll(() => document.title).toBe("Emojery — Onboarding 1/3");
  });

  it("ticks the pin step off when the icon is already on the toolbar", async () => {
    stubPinState(true);
    renderPage();

    // The pin check runs in a useEffect, which real engines flush on the next
    // frame - poll rather than count on a timeout.
    await expect.poll(() => container.querySelectorAll(".step.done").length).toBe(2);
    expect(container.querySelector(".step.done ~ .step.done")?.textContent).toContain("Pinned!");
  });

  // There is no pin/unpin event to subscribe to, so the step is only as live as
  // the poll behind it: stopping at the first `true` stranded a "Pinned!" the
  // user had already undone.
  it("follows the toolbar back when the icon is unpinned again", async () => {
    const setPinned = stubPinState(true);
    vi.useFakeTimers();
    renderPage();
    await expect.poll(() => doneCount()).toBe(2);

    setPinned(false);

    await vi.advanceTimersByTimeAsync(PIN_POLL_MS);
    expect(doneCount()).toBe(1);
  });

  it("ticks the button step once a trigger has been looked at", async () => {
    stubPinState(false);
    renderPage();
    await expect.poll(() => doneCount()).toBe(1);

    pushFlag("trigger_seen_v1", true);

    await expect.poll(() => doneCount()).toBe(2);
  });

  // The step the content script may earn is the one this page opens: mounting a
  // trigger before the user ever met the checklist ticks nothing (ui/trigger-seen.ts).
  it("arms the button step by being on screen", async () => {
    stubPinState(false);
    renderPage();

    await expect.poll(() => shim.local.get("trigger_seen_v1")).toBe(false);
    expect(doneCount(), "arming is not the same as earning").toBe(1);
  });

  it("leaves an already-earned button step alone on a second visit", async () => {
    stubPinState(false);
    seedFlags({ sawTrigger: true });
    renderPage();

    await expect.poll(() => doneCount()).toBe(2);
    expect(shim.local.get("trigger_seen_v1")).toBe(true);
  });

  it("ticks the reaction step when the first vote retires the toolbar dot", async () => {
    stubPinState(false);
    seedFlags({ reacted: false });
    renderPage();
    await expect.poll(() => doneCount()).toBe(1);

    pushFlag("onboarding_badge_v1", false);

    await expect.poll(() => doneCount()).toBe(2);
  });
});

describe("onboarding confetti", () => {
  it("stays away while anything is still unticked", async () => {
    stubPinState(true);
    seedFlags({ sawTrigger: true, reacted: false });
    renderPage();

    await expect.poll(() => doneCount()).toBe(3);
    expect(container.querySelector(CONFETTI_SELECTOR)).toBeNull();
  });

  it("fires when the last step ticks, and says so in the progress label", async () => {
    stubPinState(true);
    seedFlags({ sawTrigger: true, reacted: false });
    renderPage();
    await expect.poll(() => doneCount()).toBe(3);

    pushFlag("onboarding_badge_v1", false);

    await expect.poll(() => container.querySelector(CONFETTI_SELECTOR)).not.toBeNull();
    expect(container.querySelectorAll(`${CONFETTI_SELECTOR} .piece`).length).toBeGreaterThan(10);
    expect(container.querySelector(".progress .label")?.textContent).toBe("All set!");
    expect(container.querySelector(".progress.complete")).not.toBeNull();
  });

  // Spent once per page: a checklist that flickers back and forth (unpin, pin)
  // must not re-fire the burst every time it completes again.
  it("never fires twice", async () => {
    const setPinned = stubPinState(true);
    seedFlags({ sawTrigger: true, reacted: true });
    vi.useFakeTimers();
    renderPage();

    await expect.poll(() => container.querySelector(CONFETTI_SELECTOR)).not.toBeNull();
    // Let the burst retire itself, then complete the list a second time.
    await vi.advanceTimersByTimeAsync(CONFETTI_MS);
    expect(container.querySelector(CONFETTI_SELECTOR)).toBeNull();
    setPinned(false);
    await vi.advanceTimersByTimeAsync(PIN_POLL_MS);
    expect(doneCount()).toBe(3);
    setPinned(true);
    await vi.advanceTimersByTimeAsync(PIN_POLL_MS);
    expect(doneCount()).toBe(4);

    expect(container.querySelector(CONFETTI_SELECTOR)).toBeNull();
  });
});
