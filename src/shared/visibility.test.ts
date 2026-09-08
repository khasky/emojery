// SPDX-License-Identifier: GPL-3.0-or-later
//
// The shared "wait for the tab" gate. No supported-site DOM - the only page state
// under test is the document's own visibility.
import { afterEach, describe, expect, it, vi } from "vitest";
import { onceVisible, whenVisible } from "./visibility";

// jsdom reports a visible document and offers no way to change it; both the
// property and the event it pairs with are simulated here.
function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
}

function goVisible(): void {
  setVisibility("visible");
  document.dispatchEvent(new Event("visibilitychange"));
}

afterEach(() => {
  setVisibility("visible");
});

describe("onceVisible", () => {
  it("runs straight away on a visible tab", () => {
    setVisibility("visible");
    const run = vi.fn();
    onceVisible(run);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("holds a hidden tab's work until it comes back", () => {
    setVisibility("hidden");
    const run = vi.fn();
    onceVisible(run);
    expect(run).not.toHaveBeenCalled();
    goVisible();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires once, however many times the tab is hidden and shown again", () => {
    setVisibility("hidden");
    const run = vi.fn();
    onceVisible(run);
    goVisible();
    setVisibility("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    goVisible();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("drops a pending wait once cancelled - the caller that asked for it is gone", () => {
    setVisibility("hidden");
    const run = vi.fn();
    onceVisible(run)();
    goVisible();
    expect(run).not.toHaveBeenCalled();
  });

  it("cancelling after the work already ran is a no-op", () => {
    setVisibility("visible");
    const run = vi.fn();
    expect(() => onceVisible(run)()).not.toThrow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("whenVisible", () => {
  it("resolves on the return to a visible tab", async () => {
    setVisibility("hidden");
    let settled = false;
    const wait = whenVisible().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    goVisible();
    await wait;
    expect(settled).toBe(true);
  });
});
