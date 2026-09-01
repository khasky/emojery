// SPDX-License-Identifier: GPL-3.0-or-later
//
// The onboarding page's self-ticking checklist: every step reflects a state the
// extension can observe on its own, the progress label follows, and the last
// tick fires the confetti exactly once.
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SUPPORTED_SITES } from "../../shared/sites";
import { mountContainer, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim } from "../../test/chrome-shim";
import { App } from "./main";

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
  if (flags.sawTrigger !== undefined) shim.local.set("coach_seen_v1", flags.sawTrigger);
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
});

describe("onboarding checklist", () => {
  it("opens with only the install step ticked", async () => {
    stubPinState(false);
    seedFlags({ sawTrigger: false, reacted: false });
    renderPage();

    await expect.poll(() => steps().length).toBe(4);
    expect(doneCount()).toBe(1);
    expect(container.querySelector(".progress .label")?.textContent).toBe("1 of 4 done");
    // The bar stays on its in-progress colour until the last tick.
    expect(container.querySelector(".progress.complete")).toBeNull();
  });

  it("lists every supported site by name inside the button step", async () => {
    stubPinState(false);
    renderPage();

    await expect.poll(() => container.querySelectorAll(".site-chips li").length).toBe(SUPPORTED_SITES.length);
    const chips = [...container.querySelectorAll(".site-chips li")].map((li) => li.textContent);
    expect(chips).toEqual(SUPPORTED_SITES.map((site) => site.label));
    // The copy around the list carries no count to go stale when a site is added.
    expect(container.querySelector(".tagline")?.textContent).not.toMatch(/\d/);
  });

  it("links Try it live at a logged-out-safe supported page with the react hint", () => {
    renderPage();

    expect(container.querySelector("a.primary")?.getAttribute("href")).toBe("https://github.com/khasky/emojery#emojery-react");
  });

  it("drops the pin step where the browser cannot report pin state", async () => {
    seedFlags({ sawTrigger: false, reacted: false });
    renderPage();

    await expect.poll(() => steps().length).toBe(3);
    expect(titles()).not.toContain("Pin it");
    expect(container.querySelector(".progress .label")?.textContent).toBe("1 of 3 done");
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
    renderPage();
    await expect.poll(() => doneCount()).toBe(2);

    setPinned(false);

    // One poll tick out (PIN_POLL_MS), so past expect.poll's own 1s default.
    await expect.poll(() => doneCount(), { timeout: 5_000 }).toBe(1);
  });

  it("ticks the button step when a trigger first mounts on a page", async () => {
    stubPinState(false);
    renderPage();
    await expect.poll(() => doneCount()).toBe(1);

    pushFlag("coach_seen_v1", true);

    await expect.poll(() => doneCount()).toBe(2);
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
    expect(container.querySelector(".confetti")).toBeNull();
  });

  it("fires when the last step ticks, and says so in the progress label", async () => {
    stubPinState(true);
    seedFlags({ sawTrigger: true, reacted: false });
    renderPage();
    await expect.poll(() => doneCount()).toBe(3);

    pushFlag("onboarding_badge_v1", false);

    await expect.poll(() => container.querySelector(".confetti")).not.toBeNull();
    expect(container.querySelectorAll(".confetti .piece").length).toBeGreaterThan(10);
    expect(container.querySelector(".progress .label")?.textContent).toBe("All set!");
    expect(container.querySelector(".progress.complete")).not.toBeNull();
  });

  // Spent once per page: a checklist that flickers back and forth (unpin, pin)
  // must not re-fire the burst every time it completes again.
  it("never fires twice", async () => {
    const setPinned = stubPinState(true);
    seedFlags({ sawTrigger: true, reacted: true });
    renderPage();

    await expect.poll(() => container.querySelector(".confetti")).not.toBeNull();
    // Let the burst retire itself, then complete the list a second time.
    await expect.poll(() => container.querySelector(".confetti"), { timeout: 6_000 }).toBeNull();
    setPinned(false);
    await expect.poll(() => doneCount(), { timeout: 5_000 }).toBe(3);
    setPinned(true);
    await expect.poll(() => doneCount(), { timeout: 5_000 }).toBe(4);

    expect(container.querySelector(".confetti")).toBeNull();
  });
});
