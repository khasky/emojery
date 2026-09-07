// SPDX-License-Identifier: GPL-3.0-or-later
//
// The per-tab injected-count badge. Every write is tab-scoped: a badge painted
// without a tabId becomes the extension's GLOBAL badge, so one supported page
// would leave its count on the toolbar over every other tab. The one deliberate
// global badge is the fresh-install onboarding dot, tested at the bottom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";

// Only the badge setters are faked; the storage functions the onboarding latch
// reads stay real and land in the chrome shim installed per test.
vi.mock("../shared/webext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/webext")>();
  return {
    ...actual,
    setToolbarBadgeBackgroundColor: vi.fn(),
    setToolbarBadgeText: vi.fn(),
    setToolbarBadgeTextColor: vi.fn(),
  };
});

import { isOnboardingBadgeActive, readPulseBursts, TOOLBAR_PINNED_KEY, writePulseBursts } from "../shared/onboarding";
import { setSettings } from "../shared/settings";
import { setToolbarBadgeBackgroundColor, setToolbarBadgeText, setToolbarBadgeTextColor } from "../shared/webext";
import { clearInjectedBadge, finishOnboardingBadge, formatBadgeCount, pulseOnboardingBadge, reassertOnboardingBadge, setInjectedBadge, startOnboardingBadge } from "./toolbar-badge";

let shim: ChromeShimHandle;

// The badge module caches the onboarding latch to keep its paint synchronous, and
// that cache is module state a fresh shim does not clear. Re-syncing it is what a
// fresh worker does anyway, so every test starts from the same place.
beforeEach(async () => {
  shim = installChromeShim();
  await reassertOnboardingBadge();
  vi.clearAllMocks();
});

afterEach(() => {
  shim.uninstall();
});

describe("formatBadgeCount", () => {
  it("clamps to the 4-char badge", () => {
    expect(formatBadgeCount(0)).toBe("");
    expect(formatBadgeCount(-1)).toBe("");
    expect(formatBadgeCount(7)).toBe("7");
    expect(formatBadgeCount(999)).toBe("999");
    expect(formatBadgeCount(1000)).toBe("999+");
  });
});

describe("setInjectedBadge", () => {
  it("paints text and both colours against the given tab only", () => {
    setInjectedBadge(42, 3);
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "3", tabId: 42 });
    expect(setToolbarBadgeBackgroundColor).toHaveBeenCalledWith({ color: expect.any(String), tabId: 42 });
    expect(setToolbarBadgeTextColor).toHaveBeenCalledWith({ color: expect.any(String), tabId: 42 });
  });
});

describe("clearInjectedBadge", () => {
  it("blanks the text for that tab without touching the colours", () => {
    clearInjectedBadge(42);
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "", tabId: 42 });
    expect(setToolbarBadgeBackgroundColor).not.toHaveBeenCalled();
    expect(setToolbarBadgeTextColor).not.toHaveBeenCalled();
  });
});

describe("onboarding toolbar dot", () => {
  it("start latches the flag and paints the global dot", async () => {
    await startOnboardingBadge();

    expect(await isOnboardingBadgeActive()).toBe(true);
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "●" });
  });

  it("reassert repaints only while the flag holds", async () => {
    await reassertOnboardingBadge();
    expect(setToolbarBadgeText).not.toHaveBeenCalled();

    await startOnboardingBadge();
    vi.mocked(setToolbarBadgeText).mockClear();
    await reassertOnboardingBadge();
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "●" });
  });

  it("finish clears the dot once and never touches the badge after", async () => {
    await startOnboardingBadge();
    vi.mocked(setToolbarBadgeText).mockClear();

    await finishOnboardingBadge();
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "" });
    expect(await isOnboardingBadgeActive()).toBe(false);

    // A later vote must not blank a per-tab count some tab is showing.
    vi.mocked(setToolbarBadgeText).mockClear();
    await finishOnboardingBadge();
    expect(setToolbarBadgeText).not.toHaveBeenCalled();
  });
});

describe("onboarding dot ownership", () => {
  it("stands the per-tab count down while the dot is owed, and hands it back after", async () => {
    await startOnboardingBadge();
    vi.mocked(setToolbarBadgeText).mockClear();

    setInjectedBadge(42, 3);
    expect(setToolbarBadgeText).not.toHaveBeenCalled();

    await finishOnboardingBadge();
    vi.mocked(setToolbarBadgeText).mockClear();
    setInjectedBadge(42, 3);
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "3", tabId: 42 });
  });
});

describe("onboarding dot pulse", () => {
  // The chrome shim carries no `action`, so getUserSettings answers null and the
  // pin can only come from the latch - which is what the onboarding page writes.
  const pinned = async (): Promise<void> => {
    shim.uninstall();
    shim = installChromeShim({ local: { [TOOLBAR_PINNED_KEY]: true } });
    await reassertOnboardingBadge();
  };

  it("does not pulse until the icon is pinned", async () => {
    await startOnboardingBadge();
    vi.mocked(setToolbarBadgeText).mockClear();

    await pulseOnboardingBadge();
    expect(setToolbarBadgeText).not.toHaveBeenCalled();
    expect(await readPulseBursts()).toBe(20);
  });

  it("spends one burst per call and settles back on the dot", async () => {
    await pinned();
    await startOnboardingBadge();
    vi.mocked(setToolbarBadgeText).mockClear();
    vi.useFakeTimers();

    const burst = pulseOnboardingBadge();
    await vi.advanceTimersByTimeAsync(300 * 10);
    await burst;
    vi.useRealTimers();

    const painted = vi.mocked(setToolbarBadgeText).mock.calls.map(([details]) => details.text);
    expect(painted.slice(0, 4)).toEqual(["◐", "◓", "◑", "◒"]);
    expect(painted).toHaveLength(9);
    expect(painted.at(-1)).toBe("●");
    expect(await readPulseBursts()).toBe(19);
  });

  it("stops pulsing once the budget is spent, keeping the latch and the still dot", async () => {
    await pinned();
    await startOnboardingBadge();
    await writePulseBursts(0);
    vi.mocked(setToolbarBadgeText).mockClear();

    await pulseOnboardingBadge();
    expect(setToolbarBadgeText).not.toHaveBeenCalled();
    expect(await isOnboardingBadgeActive()).toBe(true);
  });

  it("does not animate when the user has turned reaction animations off", async () => {
    await pinned();
    await startOnboardingBadge();
    await setSettings({ reactionAnimations: false });
    vi.mocked(setToolbarBadgeText).mockClear();

    await pulseOnboardingBadge();
    expect(setToolbarBadgeText).not.toHaveBeenCalled();
    expect(await readPulseBursts()).toBe(20);
  });

  it("drops the dot mid-burst when the first reaction lands", async () => {
    await pinned();
    await startOnboardingBadge();
    vi.mocked(setToolbarBadgeText).mockClear();
    vi.useFakeTimers();

    const burst = pulseOnboardingBadge();
    await vi.advanceTimersByTimeAsync(300 * 2);
    await finishOnboardingBadge();
    await vi.advanceTimersByTimeAsync(300 * 10);
    await burst;
    vi.useRealTimers();

    expect(vi.mocked(setToolbarBadgeText).mock.calls.at(-1)?.[0].text).toBe("");
  });
});
