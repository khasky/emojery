// SPDX-License-Identifier: GPL-3.0-or-later
//
// The per-tab injected-count badge. Every write is tab-scoped: a badge painted
// without a tabId becomes the extension's GLOBAL badge, so one supported page
// would leave its count on the toolbar over every other tab. The one deliberate
// global badge is the open-page dot, tested at the bottom.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";

// Only the badge setters are faked - the assertions here are about what reaches
// the toolbar, and nothing in this module reads storage.
vi.mock("../shared/webext", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../shared/webext")>();
  return {
    ...actual,
    setToolbarBadgeBackgroundColor: vi.fn(),
    setToolbarBadgeText: vi.fn(),
    setToolbarBadgeTextColor: vi.fn(),
  };
});

import { setToolbarBadgeBackgroundColor, setToolbarBadgeText, setToolbarBadgeTextColor } from "../shared/webext";
import { clearInjectedBadge, formatBadgeCount, setInjectedBadge, trackExtensionPage } from "./toolbar-badge";

let shim: ChromeShimHandle;

beforeEach(() => {
  shim = installChromeShim();
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

// A page's end of the presence port, reduced to the one event the badge listens to.
// The module keeps its open ports in a set that outlives a test, so every port a
// test opens is disconnected after it - the same thing a closing tab does.
const openedPorts: (() => void)[] = [];

function fakePort(tabId?: number): { port: chrome.runtime.Port; disconnect: () => void } {
  const listeners: (() => void)[] = [];
  const sender = tabId === undefined ? undefined : { tab: { id: tabId } };
  const port = { sender, onDisconnect: { addListener: (fn: () => void) => listeners.push(fn) } } as unknown as chrome.runtime.Port;
  const disconnect = (): void => {
    for (const fn of listeners) fn();
  };
  openedPorts.push(disconnect);
  return { port, disconnect };
}

describe("open-page dot", () => {
  afterEach(() => {
    for (const disconnect of openedPorts.splice(0)) disconnect();
  });

  it("paints the global dot while a page holds its port", () => {
    trackExtensionPage(fakePort().port);

    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "●" });
    expect(setToolbarBadgeBackgroundColor).toHaveBeenCalledWith({ color: expect.any(String) });
    expect(setToolbarBadgeTextColor).toHaveBeenCalledWith({ color: expect.any(String) });
  });

  it("clears the dot when the last page disconnects, not the first", () => {
    const first = fakePort();
    const second = fakePort();
    trackExtensionPage(first.port);
    trackExtensionPage(second.port);
    vi.mocked(setToolbarBadgeText).mockClear();

    first.disconnect();
    expect(setToolbarBadgeText).not.toHaveBeenCalled();

    second.disconnect();
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "" });
  });

  it("keeps the dot up when one page's disconnect fires twice", () => {
    const first = fakePort();
    const second = fakePort();
    trackExtensionPage(first.port);
    trackExtensionPage(second.port);
    vi.mocked(setToolbarBadgeText).mockClear();

    first.disconnect();
    first.disconnect();
    expect(setToolbarBadgeText).not.toHaveBeenCalled();
  });

  // The navigation that loads an extension page blanks that tab's badge, and a
  // per-tab empty string hides the global default on the very tab in front of the
  // user - so the page's own tab is painted too, and handed back on disconnect.
  it("paints the page's own tab as well as the global default", () => {
    const page = fakePort(7);
    trackExtensionPage(page.port);
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "●" });
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "●", tabId: 7 });

    vi.mocked(setToolbarBadgeText).mockClear();
    page.disconnect();
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "", tabId: 7 });
  });

  // The popup has no tab of its own; only the global default is there to paint.
  it("paints only the global default for a page with no tab", () => {
    trackExtensionPage(fakePort().port);

    expect(setToolbarBadgeText).toHaveBeenCalledTimes(1);
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "●" });
  });

  it("leaves a tab's injected count alone while the dot is up", () => {
    trackExtensionPage(fakePort().port);
    vi.mocked(setToolbarBadgeText).mockClear();

    setInjectedBadge(42, 3);
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "3", tabId: 42 });
  });
});
