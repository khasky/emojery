// SPDX-License-Identifier: GPL-3.0-or-later
//
// The one-time coach-mark's own contracts: the storage latch, the show delay,
// and every dismissal path tearing the tooltip and the pulse attribute down.
// The host/trigger here are Emojery's OWN shadow DOM, not a supported site's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COACH_ATTR, TRIGGER_CLASS } from "../shared/dom";
import { claimCoachMark } from "../shared/onboarding";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";

// jsdom reports a visible document and has no way to change it; the coach-mark
// reads the property and listens for the event, so both are simulated here.
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

// The real overlay root drags themed-host/sprite plumbing in; the coach-mark
// only needs a container to append into.
const overlay = vi.hoisted(() => ({ root: null as HTMLElement | null }));
vi.mock("./mount-shadow", () => ({
  getOverlayRoot: () => {
    if (!overlay.root) throw new Error("test forgot to create the overlay root");
    return overlay.root;
  },
}));

import { __resetCoachMarkForTest, maybeShowCoachMark } from "./coach-mark";

let shim: ChromeShimHandle;
let host: HTMLElement;

function makeHost(): HTMLElement {
  const el = document.createElement("span");
  const shadow = el.attachShadow({ mode: "open" });
  const trigger = document.createElement("button");
  trigger.className = TRIGGER_CLASS;
  shadow.appendChild(trigger);
  document.body.appendChild(el);
  // jsdom rects are all zeros; the coach-mark treats 0x0 as "hidden, nothing to
  // point at", so give the trigger a box.
  trigger.getBoundingClientRect = () => ({ width: 40, height: 20, top: 100, bottom: 120, left: 50, right: 90, x: 50, y: 100, toJSON: () => ({}) }) as DOMRect;
  return el;
}

async function showMark(): Promise<void> {
  await maybeShowCoachMark(host);
  await vi.advanceTimersByTimeAsync(1000);
}

function tip(): HTMLElement | null {
  return overlay.root?.querySelector(".khasky-emojery-coach-tip") ?? null;
}

beforeEach(() => {
  vi.useFakeTimers();
  setVisibility("visible");
  shim = installChromeShim();
  overlay.root = document.createElement("div");
  document.body.appendChild(overlay.root);
  host = makeHost();
  __resetCoachMarkForTest();
});

afterEach(() => {
  vi.useRealTimers();
  host.remove();
  overlay.root?.remove();
  overlay.root = null;
  shim.uninstall();
});

describe("maybeShowCoachMark", () => {
  it("shows the tooltip and the pulse attribute after the settle delay", async () => {
    await showMark();

    expect(tip()).not.toBeNull();
    expect(host.getAttribute(COACH_ATTR)).toBe("1");
  });

  it("is once per install: a second page never claims it again", async () => {
    await showMark();
    tip()?.remove();

    // Fresh page load (module latch reset), same profile (storage latch kept).
    __resetCoachMarkForTest();
    const secondHost = makeHost();
    await maybeShowCoachMark(secondHost);
    await vi.advanceTimersByTimeAsync(1000);

    expect(secondHost.hasAttribute(COACH_ATTR)).toBe(false);
    secondHost.remove();
  });

  it("Escape dismisses tooltip and pulse", async () => {
    await showMark();

    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(tip()).toBeNull();
    expect(host.hasAttribute(COACH_ATTR)).toBe(false);
  });

  it("interacting with the trigger dismisses - mission accomplished", async () => {
    await showMark();

    host.dispatchEvent(new Event("pointerdown"));

    expect(tip()).toBeNull();
    expect(host.hasAttribute(COACH_ATTR)).toBe(false);
  });

  it("leaves on its own after the timeout", async () => {
    await showMark();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(tip()).toBeNull();
    expect(host.hasAttribute(COACH_ATTR)).toBe(false);
  });

  // A background tab must not spend the one-shot claim - the full install-replay story lives on
  // whenVisible in coach-mark.ts.
  it("waits for the tab to be looked at before claiming anything", async () => {
    setVisibility("hidden");

    // Not awaited: while the tab is hidden the call is parked on purpose.
    void maybeShowCoachMark(host);
    await vi.advanceTimersByTimeAsync(2000);

    expect(tip()).toBeNull();
    expect(host.hasAttribute(COACH_ATTR)).toBe(false);
    // Unspent: the claim is still there for the first tab the user actually opens.
    expect(await claimCoachMark()).toBe(true);
  });

  it("shows the mark once the hidden tab is brought forward", async () => {
    setVisibility("hidden");
    const parked = maybeShowCoachMark(host);
    await vi.advanceTimersByTimeAsync(2000);
    expect(tip()).toBeNull();

    setVisibility("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    await parked;
    await vi.advanceTimersByTimeAsync(2000);

    expect(tip()).not.toBeNull();
    expect(host.getAttribute(COACH_ATTR)).toBe("1");
  });

  it("skips a host whose trigger never got a box", async () => {
    const hidden = document.createElement("span");
    const shadow = hidden.attachShadow({ mode: "open" });
    const trigger = document.createElement("button");
    trigger.className = TRIGGER_CLASS;
    shadow.appendChild(trigger);
    document.body.appendChild(hidden);

    __resetCoachMarkForTest();
    await maybeShowCoachMark(hidden);
    await vi.advanceTimersByTimeAsync(1000);

    expect(hidden.hasAttribute(COACH_ATTR)).toBe(false);
    hidden.remove();
  });
});
