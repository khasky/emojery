// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TargetRef } from "../shared/adapter";
import { defineSiteAdapter, type SiteAdapterSpec } from "./framework";

function target(id: string): TargetRef {
  return { site: "amazon", targetId: id, url: `https://example.com/${id}` };
}

function build(overrides: Partial<SiteAdapterSpec>) {
  return defineSiteAdapter({
    site: "amazon",
    findCandidates: () => [],
    resolveTarget: () => null,
    resolveBinding: () => null,
    ...overrides,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("defineSiteAdapter scan", () => {
  it("builds one point per candidate, in order", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    const adapter = build({
      findCandidates: () => [a, b],
      resolveTarget: (el) => target(el === a ? "A" : "B"),
      resolveBinding: (el) => ({ anchor: el, position: "after" }),
    });

    const points = adapter.scan(document);
    expect(points).toHaveLength(2);
    expect(points[0]?.anchor).toBe(a);
    expect(points[0]?.target.targetId).toBe("A");
    expect(points[1]?.anchor).toBe(b);
  });

  it("dedupes candidates that resolve to the same targetId", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    const adapter = build({
      findCandidates: () => [a, b],
      resolveTarget: () => target("SAME"),
      resolveBinding: (el) => ({ anchor: el, position: "after" }),
    });

    const points = adapter.scan(document);
    expect(points).toHaveLength(1);
    expect(points[0]?.anchor).toBe(a);
  });

  it("drops candidates with no target", () => {
    const a = document.createElement("div");
    const adapter = build({
      findCandidates: () => [a],
      resolveTarget: () => null,
    });
    expect(adapter.scan(document)).toEqual([]);
  });

  it("drops candidates with no binding", () => {
    const a = document.createElement("div");
    const adapter = build({
      findCandidates: () => [a],
      resolveTarget: () => target("A"),
      resolveBinding: () => null,
    });
    expect(adapter.scan(document)).toEqual([]);
  });

  it("a null binding does not consume the target - a later same-target candidate still mounts", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    const adapter = build({
      findCandidates: () => [a, b],
      resolveTarget: () => target("SAME"),
      resolveBinding: (el) => (el === a ? null : { anchor: el, position: "after" }),
    });

    const points = adapter.scan(document);
    expect(points).toHaveLength(1);
    expect(points[0]?.anchor).toBe(b);
  });

  it("dedupes by container before resolving the target", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    const container = document.createElement("div");
    const resolveTarget = vi.fn(() => target("A"));
    const adapter = build({
      findCandidates: () => [a, b],
      dedupeContainer: () => container,
      resolveTarget,
      resolveBinding: (el) => ({ anchor: el, position: "after" }),
    });

    const points = adapter.scan(document);
    expect(points).toHaveLength(1);
    expect(resolveTarget).toHaveBeenCalledTimes(1);
  });

  it("drops candidates whose dedupeContainer returns null", () => {
    const a = document.createElement("div");
    const adapter = build({
      findCandidates: () => [a],
      dedupeContainer: () => null,
      resolveTarget: () => target("A"),
      resolveBinding: (el) => ({ anchor: el, position: "after" }),
    });
    expect(adapter.scan(document)).toEqual([]);
  });

  it("isPrivatePage short-circuits the scan to no points, skipping all candidate work", () => {
    const a = document.createElement("div");
    const findCandidates = vi.fn(() => [a]);
    const adapter = build({
      isPrivatePage: () => true,
      findCandidates,
      resolveTarget: () => target("A"),
      resolveBinding: (el) => ({ anchor: el, position: "after" }),
    });

    expect(adapter.scan(document)).toEqual([]);
    expect(findCandidates).not.toHaveBeenCalled();
  });

  it("isPrivatePage returning false leaves the scan unaffected", () => {
    const a = document.createElement("div");
    const adapter = build({
      isPrivatePage: () => false,
      findCandidates: () => [a],
      resolveTarget: () => target("A"),
      resolveBinding: (el) => ({ anchor: el, position: "after" }),
    });

    expect(adapter.scan(document)).toHaveLength(1);
  });
});

describe("defineSiteAdapter matches + ctx.memo", () => {
  it("matches is the registry run-host check", () => {
    const adapter = defineSiteAdapter({
      site: "amazon",
      findCandidates: () => [],
      resolveTarget: () => null,
      resolveBinding: () => null,
    });
    expect(adapter.matches("www.amazon.com")).toBe(true);
    expect(adapter.matches("www.amazon.nl")).toBe(true); // hostRegex catch-all
    expect(adapter.matches("github.com")).toBe(false);
  });

  it("ctx.memo computes once per key across callbacks and caches a null result", () => {
    const a = document.createElement("div");
    const compute = vi.fn((): string | null => null);
    const adapter = build({
      findCandidates: () => [a],
      resolveTarget: (el, ctx) => {
        ctx.memo(el, compute);
        return target("A");
      },
      resolveBinding: (el, ctx) => {
        ctx.memo(el, compute);
        return { anchor: el, position: "after" };
      },
    });

    adapter.scan(document);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe("defineSiteAdapter observe", () => {
  it("wires the default scan observer (initial scan after debounce)", () => {
    vi.useFakeTimers();
    const a = document.createElement("div");
    const adapter = build({
      findCandidates: () => [a],
      resolveTarget: () => target("A"),
      resolveBinding: (el) => ({ anchor: el, position: "after" }),
      observer: {},
    });
    const onUpdate = vi.fn();

    const stop = adapter.observe(onUpdate);
    vi.advanceTimersByTime(250);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate.mock.calls[0]?.[0]).toHaveLength(1);
    stop();
  });
});
