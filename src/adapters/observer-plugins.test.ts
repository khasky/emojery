// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { lazyHoverPriming, shadowRootDiscovery, urlChangeRescan } from "./observer-plugins";
import type { ObserverPluginContext } from "./scan-observer";

function ctx(): { ctx: ObserverPluginContext; trigger: ReturnType<typeof vi.fn> } {
  const trigger = vi.fn();
  return { ctx: { trigger }, trigger };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("lazyHoverPriming", () => {
  it("triggers on a hover inside the selector, and again after the delay", () => {
    vi.useFakeTimers();
    const { ctx: c, trigger } = ctx();
    const teardown = lazyHoverPriming({ selector: "a.date", delaysMs: [0, 400] }).attach(c);
    const link = document.createElement("a");
    link.className = "date";
    document.body.appendChild(link);

    link.dispatchEvent(new Event("mouseover", { bubbles: true }));
    expect(trigger).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(400);
    expect(trigger).toHaveBeenCalledTimes(2);

    teardown();
    link.dispatchEvent(new Event("mouseover", { bubbles: true }));
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it("ignores hovers outside the selector", () => {
    const { ctx: c, trigger } = ctx();
    lazyHoverPriming({ selector: "a.date", delaysMs: [0] }).attach(c);
    const other = document.createElement("div");
    document.body.appendChild(other);
    other.dispatchEvent(new Event("mouseover", { bubbles: true }));
    expect(trigger).not.toHaveBeenCalled();
  });
});

describe("urlChangeRescan", () => {
  it("re-scans at the settle delays when the pathname changes", () => {
    vi.useFakeTimers();
    const { ctx: c, trigger } = ctx();
    const teardown = urlChangeRescan({
      pollMs: 100,
      settleMs: [0, 200],
    }).attach(c);

    vi.advanceTimersByTime(100);
    expect(trigger).not.toHaveBeenCalled();

    // SPA nav advances via pushState (no popstate); jsdom updates the URL.
    history.pushState({}, "", "/p/ABC/");
    vi.advanceTimersByTime(100);
    expect(trigger).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(trigger).toHaveBeenCalledTimes(2);

    teardown();
    history.pushState({}, "", "/reel/DEF/");
    vi.advanceTimersByTime(400);
    expect(trigger).toHaveBeenCalledTimes(2);
  });

  it("ignores a query-only change (default pathname key)", () => {
    vi.useFakeTimers();
    const { ctx: c, trigger } = ctx();
    history.pushState({}, "", "/p/ABC/");
    const teardown = urlChangeRescan({ pollMs: 100, settleMs: [0] }).attach(c);

    // Swiping carousel images changes only the query.
    history.pushState({}, "", "/p/ABC/?img_index=2");
    vi.advanceTimersByTime(150);
    expect(trigger).not.toHaveBeenCalled();
    teardown();
  });

  // The poll is the extension's one always-on timer, so a hidden tab must stop
  // it outright rather than tick-and-return - and returning must not lose a
  // navigation that happened while the tab was away.
  it("stops polling while the tab is hidden and catches up on return", () => {
    vi.useFakeTimers();
    const { ctx: c, trigger } = ctx();
    history.pushState({}, "", "/p/START/");
    const teardown = urlChangeRescan({ pollMs: 100, settleMs: [0] }).attach(c);

    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    history.pushState({}, "", "/p/WHILE_HIDDEN/");
    vi.advanceTimersByTime(500);
    expect(trigger).not.toHaveBeenCalled();

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(trigger).toHaveBeenCalledTimes(1);

    hidden.mockRestore();
    teardown();
  });
});

describe("shadowRootDiscovery", () => {
  it("observes an open shadow root and triggers on mutation, then disconnects", async () => {
    const { ctx: c, trigger } = ctx();
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    document.body.appendChild(host);

    const teardown = shadowRootDiscovery({ attributeFilter: ["id"] }).attach(c);
    trigger.mockClear();

    shadow.appendChild(document.createElement("span"));
    await Promise.resolve(); // let the MutationObserver microtask flush
    expect(trigger).toHaveBeenCalled();

    teardown();
    const before = trigger.mock.calls.length;
    shadow.appendChild(document.createElement("span"));
    await Promise.resolve();
    expect(trigger.mock.calls.length).toBe(before); // disconnected
  });
});
