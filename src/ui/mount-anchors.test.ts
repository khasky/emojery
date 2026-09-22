// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetKey } from "../shared/storage";
import { cancelAllPendingMounts, isNearPrefetchMargin, observePendingAnchor, reobservePendingAnchor, setPendingAnchorHandler } from "./mount-anchors";

// jsdom ships no IntersectionObserver. This one counts how often a target is
// (re-)observed, which is the whole question here.
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly targets = new Set<Element>();
  readonly rootMargin: string;
  observeCalls = 0;
  unobserveCalls = 0;
  constructor(
    private readonly callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    this.rootMargin = options?.rootMargin ?? "0px";
    FakeIntersectionObserver.instances.push(this);
  }
  observe(target: Element): void {
    this.observeCalls++;
    this.targets.add(target);
  }
  unobserve(target: Element): void {
    this.unobserveCalls++;
    this.targets.delete(target);
  }
  disconnect(): void {
    this.targets.clear();
  }
  emit(target: Element, isIntersecting: boolean): void {
    this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
  }
}

const KEY = "facebook:1" as TargetKey;

function anchorEl(): HTMLElement {
  const el = document.createElement("div");
  document.body.append(el);
  return el;
}

function observer(): FakeIntersectionObserver {
  const last = FakeIntersectionObserver.instances.at(-1);
  if (!last) throw new Error("nothing is watching the viewport");
  return last;
}

describe("observePendingAnchor", () => {
  beforeEach(() => {
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
    // The module keeps ONE observer for the life of the tab and the test seam leaves it
    // standing, so each case resets its counters instead of expecting a fresh instance.
    for (const instance of FakeIntersectionObserver.instances) {
      instance.observeCalls = 0;
      instance.unobserveCalls = 0;
    }
  });

  afterEach(() => {
    cancelAllPendingMounts();
    setPendingAnchorHandler(() => {});
    vi.unstubAllGlobals();
    document.body.innerHTML = "";
  });

  it("leaves a live observation of the same anchor alone", () => {
    const anchor = anchorEl();
    observePendingAnchor(KEY, anchor);
    const io = observer();
    expect(io.observeCalls).toBe(1);

    // What a re-scan does on every tick while the mount is still deferred. Re-adding
    // the target restarts intersection delivery, and the delivery is the mount's only
    // signal once the anchor is out of the synchronous probe's reach.
    reobservePendingAnchor(KEY, anchor);
    reobservePendingAnchor(KEY, anchor);
    observePendingAnchor(KEY, anchor);

    expect(io.observeCalls).toBe(1);
    expect(io.unobserveCalls).toBe(0);
    expect(io.targets.has(anchor)).toBe(true);
  });

  it("moves the observation when the scan hands back a different anchor", () => {
    const first = anchorEl();
    const second = anchorEl();
    observePendingAnchor(KEY, first);
    const io = observer();

    reobservePendingAnchor(KEY, second);

    expect(io.observeCalls).toBe(2);
    expect(io.targets.has(first)).toBe(false);
    expect(io.targets.has(second)).toBe(true);
  });

  // The two halves of the same band: a probe that reached further than the observer
  // would mount on an anchor the observer is still waiting on, and one that reached
  // less far would leave the mount to a delivery the feed's recycling keeps cancelling.
  it("answers over the same band the observer watches", () => {
    const anchor = anchorEl();
    observePendingAnchor(KEY, anchor);
    const margin = Number.parseInt(observer().rootMargin, 10);
    expect(Number.isFinite(margin)).toBe(true);

    const viewportHeight = window.innerHeight;
    const rectAt = (top: number) => () => ({ top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40 }) as DOMRect;

    anchor.getBoundingClientRect = rectAt(viewportHeight + margin - 10);
    expect(isNearPrefetchMargin(anchor)).toBe(true);

    anchor.getBoundingClientRect = rectAt(viewportHeight + margin + 10);
    expect(isNearPrefetchMargin(anchor)).toBe(false);
  });

  // The observer's rootMargin is vertical only, so a horizontally offscreen anchor
  // on a carousel or a side rail never delivers. A probe with horizontal slack
  // answers "near" for it, and the eager mount that follows is the double-mount the
  // shared band exists to prevent.
  it("gives the horizontal edge no slack the observer does not have", () => {
    const anchor = anchorEl();
    observePendingAnchor(KEY, anchor);

    const viewportWidth = window.innerWidth;
    const rectFrom = (left: number) => () => ({ top: 0, bottom: 40, left, right: left + 100, width: 100, height: 40 }) as DOMRect;

    anchor.getBoundingClientRect = rectFrom(viewportWidth - 10);
    expect(isNearPrefetchMargin(anchor)).toBe(true);

    anchor.getBoundingClientRect = rectFrom(viewportWidth + 10);
    expect(isNearPrefetchMargin(anchor)).toBe(false);

    anchor.getBoundingClientRect = rectFrom(-110);
    expect(isNearPrefetchMargin(anchor)).toBe(false);
  });

  it("still reports the anchor as visible once it intersects", () => {
    const seen: TargetKey[] = [];
    setPendingAnchorHandler((key) => seen.push(key));
    const anchor = anchorEl();
    observePendingAnchor(KEY, anchor);
    reobservePendingAnchor(KEY, anchor);

    observer().emit(anchor, true);

    expect(seen).toEqual([KEY]);
  });
});
