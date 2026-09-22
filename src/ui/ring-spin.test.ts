// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_CLASS } from "../shared/dom";
import { ANIMATE_ATTR, RING_SPIN_WINDOW_MS, setRingAnimation } from "./ring-spin";

// The ring's spin is the extension's most expensive idle cost: a masked, clipped box the GPU
// re-rasters every frame it turns, against nothing at all with it off. A regression here is
// silent (the button looks right, the battery drains), so the window and its re-arm are pinned.
// This file measures neither - it pins the bounds; the cost is what motivates them. jsdom has no
// IntersectionObserver, so setRingAnimation takes its spin-straight-away branch; the observer
// path runs the same startRingSpin call.
describe("ring spin window", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("parks the spin after its window and re-arms it on pointer or focus", () => {
    vi.useFakeTimers();
    const host = document.createElement("span");
    host.className = HOST_CLASS;
    document.body.append(host);

    setRingAnimation(host, true);
    expect(host.hasAttribute(ANIMATE_ATTR), "a fresh host greets the user").toBe(true);

    vi.advanceTimersByTime(RING_SPIN_WINDOW_MS);
    expect(host.hasAttribute(ANIMATE_ATTR), "the window must end on its own").toBe(false);

    host.dispatchEvent(new Event("pointerenter"));
    expect(host.hasAttribute(ANIMATE_ATTR), "pointing at the trigger brings it back").toBe(true);
    vi.advanceTimersByTime(RING_SPIN_WINDOW_MS);
    expect(host.hasAttribute(ANIMATE_ATTR)).toBe(false);

    host.dispatchEvent(new Event("focusin"));
    expect(host.hasAttribute(ANIMATE_ATTR), "keyboard focus counts as looking at it").toBe(true);

    setRingAnimation(host, false);
    expect(host.hasAttribute(ANIMATE_ATTR)).toBe(false);
    // A host the setting switched off no longer answers the wake events.
    host.dispatchEvent(new Event("pointerenter"));
    expect(host.hasAttribute(ANIMATE_ATTR)).toBe(false);
    host.remove();
  });
});
