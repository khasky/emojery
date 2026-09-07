// SPDX-License-Identifier: GPL-3.0-or-later
//
// What counts as the user having LOOKED at a trigger. The host here is Emojery's
// own element, not a supported site's markup: every condition under test is the
// extension's own (a storage latch, tab visibility, window focus, the viewport
// observer's verdict), so none of it needs a page to pretend to be anything.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { armTriggerSeen, hasSeenTrigger, markTriggerSeen } from "../shared/onboarding";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { __resetTriggerSeenForTest, forgetTriggerSeenHost, watchTriggerSeen } from "./trigger-seen";

// jsdom reports a visible, focused document and offers no way to change either.
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

function setFocus(focused: boolean): void {
  Object.defineProperty(document, "hasFocus", { value: () => focused, configurable: true });
}

// jsdom ships no IntersectionObserver. This one records its targets and lets a
// test say what the viewport thinks of them.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  constructor(private readonly callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  emit(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

let shim: ChromeShimHandle;
let host: HTMLElement;

function makeHost(): HTMLElement {
  const el = document.createElement("span");
  el.attachShadow({ mode: "open" });
  document.body.appendChild(el);
  return el;
}

function observer(): FakeIntersectionObserver {
  const last = FakeIntersectionObserver.instances.at(-1);
  if (!last) throw new Error("nothing is watching the viewport");
  return last;
}

/** Mount, let the storage read settle, then report the trigger as on screen. */
async function mountAndShow(el: HTMLElement = host): Promise<void> {
  watchTriggerSeen(el);
  await vi.advanceTimersByTimeAsync(0);
  observer().emit(el, true);
}

/** Longer than the module's own look window. */
const LOOKED_AT_MS = 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  FakeIntersectionObserver.instances = [];
  setVisibility("visible");
  setFocus(true);
  shim = installChromeShim();
  host = makeHost();
  __resetTriggerSeenForTest();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  host.remove();
  shim.uninstall();
});

describe("watchTriggerSeen", () => {
  it("earns the step after a full look", async () => {
    await armTriggerSeen();
    await mountAndShow();

    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS);

    expect(await hasSeenTrigger()).toBe(true);
  });

  // The bug: a fresh install replays its content scripts into every open supported
  // tab, long before the user has met the checklist those tabs would tick.
  it("ticks nothing while the checklist has not been seen", async () => {
    watchTriggerSeen(host);
    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 5);

    expect(await hasSeenTrigger()).toBe(false);
    expect(FakeIntersectionObserver.instances, "an unarmed step watches no viewport at all").toHaveLength(0);
  });

  // The other half of that bug: `visibilityState` calls the active tab of a
  // second, unfocused window visible.
  it("ticks nothing in an unfocused window", async () => {
    await armTriggerSeen();
    setFocus(false);
    await mountAndShow();

    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 5);

    expect(await hasSeenTrigger()).toBe(false);
  });

  it("ticks nothing in a background tab", async () => {
    await armTriggerSeen();
    setVisibility("hidden");
    await mountAndShow();

    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 5);

    expect(await hasSeenTrigger()).toBe(false);
  });

  it("ticks nothing while the trigger is off screen", async () => {
    await armTriggerSeen();
    watchTriggerSeen(host);
    await vi.advanceTimersByTimeAsync(0);

    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 5);

    expect(await hasSeenTrigger()).toBe(false);
  });

  // A host is held `visibility: hidden` until its glyph is measured
  // (mount-style.ts), and the viewport observer reports that as intersecting.
  it("ticks nothing for a host still hidden for sizing", async () => {
    await armTriggerSeen();
    host.style.visibility = "hidden";
    await mountAndShow();

    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 5);

    expect(await hasSeenTrigger()).toBe(false);
  });

  it("a glance shorter than the window earns nothing", async () => {
    await armTriggerSeen();
    await mountAndShow();

    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS / 2);
    observer().emit(host, false);
    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 5);

    expect(await hasSeenTrigger()).toBe(false);
  });

  it("resumes when the window is focused again", async () => {
    await armTriggerSeen();
    setFocus(false);
    await mountAndShow();
    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 2);

    setFocus(true);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS);

    expect(await hasSeenTrigger()).toBe(true);
  });

  // The install opens the checklist page and replays the content scripts in the
  // same breath, so the arming routinely lands after a tab is already watching.
  it("picks up an arming that arrives later", async () => {
    watchTriggerSeen(host);
    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 2);
    expect(await hasSeenTrigger()).toBe(false);

    await armTriggerSeen();
    shim.emitChanged("local", { trigger_seen_v1: { newValue: false } });
    await vi.advanceTimersByTimeAsync(0);
    observer().emit(host, true);
    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS);

    expect(await hasSeenTrigger()).toBe(true);
  });

  // Nothing to earn: an already-ticked step must not cost every later page an
  // observer and a timer.
  it("stays out of the way once the step is earned", async () => {
    await markTriggerSeen();

    watchTriggerSeen(host);
    await vi.advanceTimersByTimeAsync(0);

    expect(FakeIntersectionObserver.instances).toHaveLength(0);
  });

  it("forgets a recycled host, and with it the look it was carrying", async () => {
    await armTriggerSeen();
    await mountAndShow();

    forgetTriggerSeenHost(host);
    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS * 5);

    expect(await hasSeenTrigger()).toBe(false);
    expect(observer().targets.has(host)).toBe(false);
  });

  // A feed recycles cards constantly; the look belongs to whichever trigger is
  // on screen now, not to the one that scrolled away.
  it("counts a second host after the first is recycled", async () => {
    await armTriggerSeen();
    await mountAndShow();
    forgetTriggerSeenHost(host);

    const next = makeHost();
    await mountAndShow(next);
    await vi.advanceTimersByTimeAsync(LOOKED_AT_MS);

    expect(await hasSeenTrigger()).toBe(true);
    next.remove();
  });
});
