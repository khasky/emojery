// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearAuth: vi.fn(),
  clearPendingDeletion: vi.fn(),
  clearCountsCache: vi.fn(),
}));

vi.mock("./identity", () => ({
  clearAuth: mocks.clearAuth,
  clearPendingDeletion: mocks.clearPendingDeletion,
}));

vi.mock("../shared/storage", () => ({
  clearCountsCache: mocks.clearCountsCache,
}));

import { firefoxDataConsentManifest } from "../test/fixtures";
import { storageGetKeys } from "../test/storage-keys";
import { injectIntoOpenTabs, installFreshInstallAuthReset, openLegacyDataConsentNotice, openOnboardingPage, resetAuthOnFreshInstall } from "./install";

let installedListener: ((details: chrome.runtime.InstalledDetails) => void) | null = null;
let createTabMock = vi.fn();

// A Firefox build's chrome, with `dataCollection` standing in for what permissions.getAll
// reports: an array on Firefox 140+, undefined on the older builds that never prompted.
function stubFirefoxChrome(dataCollection: string[] | undefined): void {
  createTabMock = vi.fn().mockResolvedValue({ id: 1 });
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => firefoxDataConsentManifest,
      getURL: (path: string) => `moz-extension://test/${path}`,
      onInstalled: {
        addListener: vi.fn((listener) => {
          installedListener = listener;
        }),
      },
    },
    permissions: {
      getAll: vi.fn((done: (granted: unknown) => void) => done({ permissions: [], origins: [], ...(dataCollection ? { data_collection: dataCollection } : {}) })),
    },
    tabs: { create: createTabMock },
  } as unknown as typeof chrome);
}

// The full surface the install listener touches: manifest (consent check +
// open-tab replay), tabs.create (consent/onboarding tabs), storage + action (the
// onboarding dot). Chrome-shaped - no gecko block, so no legacy consent.
function stubChromiumChrome(): { createTab: ReturnType<typeof vi.fn>; setBadgeText: ReturnType<typeof vi.fn>; local: Map<string, unknown> } {
  const local = new Map<string, unknown>();
  const createTab = vi.fn((_details: unknown, done?: (tab: unknown) => void) => done?.({ id: 1 }));
  const setBadgeText = vi.fn();
  vi.stubGlobal("chrome", {
    runtime: {
      getManifest: () => ({ version: "0.0.0-test" }),
      getURL: (path: string) => `chrome-extension://test/${path}`,
      onInstalled: {
        addListener: vi.fn((listener) => {
          installedListener = listener;
        }),
      },
    },
    tabs: { create: createTab, query: vi.fn((_q: unknown, done: (tabs: unknown[]) => void) => done([])) },
    storage: {
      local: {
        get: vi.fn((keys: unknown, done: (items: Record<string, unknown>) => void) => {
          const out: Record<string, unknown> = {};
          for (const k of storageGetKeys(local.keys(), keys)) if (local.has(k)) out[k] = local.get(k);
          done(out);
        }),
        set: vi.fn((items: Record<string, unknown>, done?: () => void) => {
          for (const [k, v] of Object.entries(items)) local.set(k, v);
          done?.();
        }),
        remove: vi.fn((keys: string | string[], done?: () => void) => {
          for (const k of Array.isArray(keys) ? keys : [keys]) local.delete(k);
          done?.();
        }),
      },
    },
    action: { setBadgeText, setBadgeBackgroundColor: vi.fn(), setBadgeTextColor: vi.fn() },
  } as unknown as typeof chrome);
  return { createTab, setBadgeText, local };
}

beforeEach(() => {
  installedListener = null;
  mocks.clearAuth.mockReset().mockResolvedValue(undefined);
  mocks.clearPendingDeletion.mockReset().mockResolvedValue(undefined);
  mocks.clearCountsCache.mockReset().mockResolvedValue(undefined);
  stubChromiumChrome();
});

// The onInstalled listeners are sync functions that kick off async work and return, so a
// bare `await Promise.resolve()` only drains one tick. A macrotask hop drains the whole
// chain (resetAuthOnFreshInstall awaits several steps) without pinning how many there are.
const drainInstallHandlers = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("install lifecycle", () => {
  it("clears auth and per-user counts cache on a fresh install", async () => {
    await resetAuthOnFreshInstall();

    expect(mocks.clearAuth).toHaveBeenCalledTimes(1);
    expect(mocks.clearPendingDeletion).toHaveBeenCalledTimes(1);
    expect(mocks.clearCountsCache).toHaveBeenCalledTimes(1);
  });

  it("registers an install-only auth reset listener", async () => {
    installFreshInstallAuthReset();

    expect(chrome.runtime.onInstalled.addListener).toHaveBeenCalledTimes(1);
    expect(installedListener).not.toBeNull();

    installedListener?.({
      reason: "update",
      previousVersion: "0.1.201",
    } as chrome.runtime.InstalledDetails);
    await Promise.resolve();
    expect(mocks.clearAuth).not.toHaveBeenCalled();

    installedListener?.({ reason: "install" } as chrome.runtime.InstalledDetails);
    await drainInstallHandlers();

    expect(mocks.clearAuth).toHaveBeenCalledTimes(1);
    expect(mocks.clearPendingDeletion).toHaveBeenCalledTimes(1);
    expect(mocks.clearCountsCache).toHaveBeenCalledTimes(1);
  });
});

describe("fresh-install injection into open tabs", () => {
  const manifest = {
    content_scripts: [
      { matches: ["https://www.reddit.com/*"], js: ["content-scripts/reddit.js"] },
      { matches: ["https://x.com/*"], js: ["content-scripts/x.js"] },
    ],
  };

  function stubTabs(tabsByPattern: Record<string, chrome.tabs.Tab[]>, executeScript: ReturnType<typeof vi.fn>): void {
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => manifest },
      tabs: {
        query: vi.fn((queryInfo: chrome.tabs.QueryInfo, done: (tabs: chrome.tabs.Tab[]) => void) => {
          expect(queryInfo.status).toBe("complete");
          done(tabsByPattern[String(queryInfo.url)] ?? []);
        }),
      },
      scripting: { executeScript },
    } as unknown as typeof chrome);
  }

  it("replays each content script into the already-open tabs it matches", async () => {
    const executeScript = vi.fn((_injection: unknown, done: (results: unknown[]) => void) => done([]));
    stubTabs(
      {
        "https://www.reddit.com/*": [{ id: 7 } as chrome.tabs.Tab, { id: 8 } as chrome.tabs.Tab],
        "https://x.com/*": [{ id: 9 } as chrome.tabs.Tab],
      },
      executeScript,
    );

    await injectIntoOpenTabs();

    expect(executeScript.mock.calls.map(([injection]) => injection)).toEqual([
      { target: { tabId: 7 }, files: ["content-scripts/reddit.js"] },
      { target: { tabId: 8 }, files: ["content-scripts/reddit.js"] },
      { target: { tabId: 9 }, files: ["content-scripts/x.js"] },
    ]);
  });

  it("keeps going when one tab refuses the injection", async () => {
    const executeScript = vi.fn((injection: { target: { tabId: number } }, done: (results: unknown[]) => void) => {
      if (injection.target.tabId === 7) throw new Error("Cannot access contents of the page");
      done([]);
    });
    stubTabs({ "https://www.reddit.com/*": [{ id: 7 } as chrome.tabs.Tab], "https://x.com/*": [{ id: 9 } as chrome.tabs.Tab] }, executeScript);

    await injectIntoOpenTabs();

    expect(executeScript).toHaveBeenCalledTimes(2);
  });
});

describe("onboarding page + toolbar dot on fresh install", () => {
  it("opens onboarding.html and arms the global toolbar dot", async () => {
    const { createTab, setBadgeText, local } = stubChromiumChrome();
    installFreshInstallAuthReset();

    installedListener?.({ reason: "install" } as chrome.runtime.InstalledDetails);
    await drainInstallHandlers();

    expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://test/onboarding.html" }, expect.any(Function));
    // The dot is the GLOBAL default badge - no tabId.
    expect(setBadgeText).toHaveBeenCalledWith({ text: "●" }, expect.any(Function));
    expect(local.get("onboarding_badge_v1")).toBe(true);
  });

  it("wipes the previous install's onboarding progress, and still arms the dot", async () => {
    const { setBadgeText, local } = stubChromiumChrome();
    local.set("coach_seen_v1", true);
    local.set("onboarding_badge_v1", false);
    installFreshInstallAuthReset();

    installedListener?.({ reason: "install" } as chrome.runtime.InstalledDetails);
    await drainInstallHandlers();

    expect(local.has("coach_seen_v1"), "the coach-mark is owed to the new install too").toBe(false);
    // Armed AFTER the wipe: the reverse order would leave no dot at all.
    expect(local.get("onboarding_badge_v1")).toBe(true);
    expect(setBadgeText).toHaveBeenCalledWith({ text: "●" }, expect.any(Function));
  });

  it("never fires on an update", async () => {
    const { createTab, setBadgeText } = stubChromiumChrome();
    installFreshInstallAuthReset();

    installedListener?.({ reason: "update", previousVersion: "0.1.201" } as chrome.runtime.InstalledDetails);
    await drainInstallHandlers();

    expect(createTab).not.toHaveBeenCalled();
    expect(setBadgeText).not.toHaveBeenCalled();
  });

  // Firefox temporary add-ons (web-ext dev, the e2e install) re-fire "install"
  // on every browser start; their onboarding tab would steal the active tab each time.
  it("skips the onboarding tab on a temporary install", async () => {
    const { createTab } = stubChromiumChrome();

    await openOnboardingPage({ reason: "install", temporary: true } as chrome.runtime.InstalledDetails);

    expect(createTab).not.toHaveBeenCalled();
  });

  // One first-run tab, never two: the pre-140 Firefox consent tab wins.
  it("yields to the legacy data-consent tab", async () => {
    stubFirefoxChrome(undefined);

    await openOnboardingPage({ reason: "install" } as chrome.runtime.InstalledDetails);

    expect(createTabMock).not.toHaveBeenCalled();
  });
});

describe("legacy data consent notice", () => {
  it("opens the disclosure on a Firefox too old to prompt for data collection", async () => {
    stubFirefoxChrome(undefined);

    await openLegacyDataConsentNotice();

    expect(createTabMock).toHaveBeenCalledWith({ url: "moz-extension://test/auth.html?consent=1" }, expect.any(Function));
  });

  it("stays out of the way when the browser prompts for itself", async () => {
    stubFirefoxChrome([]);

    await openLegacyDataConsentNotice();

    expect(createTabMock).not.toHaveBeenCalled();
  });

  it("rides the fresh-install listener, not an update", async () => {
    stubFirefoxChrome(undefined);
    installFreshInstallAuthReset();

    installedListener?.({ reason: "update", previousVersion: "0.1.201" } as chrome.runtime.InstalledDetails);
    await drainInstallHandlers();
    expect(createTabMock).not.toHaveBeenCalled();

    installedListener?.({ reason: "install" } as chrome.runtime.InstalledDetails);
    await drainInstallHandlers();
    expect(createTabMock).toHaveBeenCalledTimes(1);
  });
});
