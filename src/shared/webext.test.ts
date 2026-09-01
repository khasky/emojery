// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { RUNTIME_MESSAGE_TIMEOUT_MS } from "./config";
import { addAlarmListener, createAlarm, permissionsGetAll, queryActiveTab, sendRuntimeMessage, setToolbarBadgeText, storageLocalGet, storageLocalGetKeys, storageLocalSet } from "./webext";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("webext helpers", () => {
  it("resolves callback-only chrome.storage APIs", async () => {
    const get = vi.fn((_keys, done: (items: Record<string, unknown>) => void) => done({ auth_v1: { token: "t" } }));
    vi.stubGlobal("chrome", {
      storage: { local: { get } },
    });

    await expect(storageLocalGet(["auth_v1"])).resolves.toEqual({
      auth_v1: { token: "t" },
    });
    expect(get).toHaveBeenCalledWith(["auth_v1"], expect.any(Function));
  });

  it("also resolves promise-returning chrome.storage APIs", async () => {
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      storage: { local: { set } },
    });

    await expect(storageLocalSet({ auth_v1: { token: "t" } })).resolves.toBeUndefined();
    expect(set).toHaveBeenCalledWith({ auth_v1: { token: "t" } }, expect.any(Function));
  });

  // Chrome answers these callbacks asynchronously and returns undefined from the call
  // itself. A synchronous mock hides that: only a deferred callback proves the promise
  // waits for the real answer instead of settling on a fallback value first.
  it("waits for a deferred storage.getKeys callback", async () => {
    const getKeys = vi.fn((done: (keys: string[]) => void) => {
      setTimeout(() => done(["cache:x@github", "auth_v1"]), 0);
    });
    vi.stubGlobal("chrome", { storage: { local: { getKeys } } });

    await expect(storageLocalGetKeys()).resolves.toEqual(["cache:x@github", "auth_v1"]);
  });

  it("falls back to get(null) keys when the engine has no storage.getKeys", async () => {
    const get = vi.fn((_keys, done: (items: Record<string, unknown>) => void) => done({ "cache:a": 1, settings: {} }));
    vi.stubGlobal("chrome", { storage: { local: { get } } });

    await expect(storageLocalGetKeys()).resolves.toEqual(["cache:a", "settings"]);
  });

  it("waits for a deferred permissions.getAll callback", async () => {
    const getAll = vi.fn((done: (permissions: chrome.permissions.Permissions) => void) => {
      setTimeout(() => done({ permissions: ["alarms"] }), 0);
    });
    vi.stubGlobal("chrome", { permissions: { getAll } });

    await expect(permissionsGetAll()).resolves.toEqual({ permissions: ["alarms"] });
  });

  it("uses browserAction when Firefox MV2 has no action API", () => {
    const setBadgeText = vi.fn((_details, done?: () => void) => done?.());
    vi.stubGlobal("chrome", {
      browserAction: { setBadgeText },
    });

    setToolbarBadgeText({ text: "1", tabId: 10 });

    expect(setBadgeText).toHaveBeenCalledWith({ text: "1", tabId: 10 }, expect.any(Function));
  });

  // Chrome only treats an API error as handled when the callback reads
  // runtime.lastError, and logs "Unchecked runtime.lastError: No tab with id: N"
  // on the extension's error page when it does not. The toolbar setters answer
  // AFTER their wrapper already settled (a callback-style API returns undefined,
  // so the `?? done()` fallback fires too), so it is that second, deferred call
  // that has to do the reading - the ordinary path whenever a tab closes
  // mid-navigation.
  it("reads lastError from a toolbar callback that lands after the wrapper settled", async () => {
    let reads = 0;
    let answer: (() => void) | undefined;
    const setBadgeText = vi.fn((_details, done?: () => void) => {
      answer = done;
    });
    vi.stubGlobal("chrome", {
      action: { setBadgeText },
      runtime: {
        get lastError() {
          reads += 1;
          return { message: "No tab with id: 645217660." };
        },
      },
    });

    setToolbarBadgeText({ text: "1", tabId: 645217660 });
    const before = reads;
    answer?.();

    expect(reads, "the deferred callback must touch lastError, settled or not").toBeGreaterThan(before);
  });

  // An invalidated extension context (the extension reloaded under a live content
  // script) makes the lastError getter itself throw. Letting that escape would take
  // the caller's callback down with it, leaving the page half-mounted and no error
  // path run - the failure a reload is the only cure for.
  it("survives a lastError getter that throws on an invalidated context", async () => {
    const get = vi.fn((_keys: unknown, done: (items: Record<string, unknown>) => void) => done({ ok: 1 }));
    vi.stubGlobal("chrome", {
      storage: { local: { get } },
      runtime: {
        get lastError(): never {
          throw new Error("Extension context invalidated.");
        },
      },
    });

    await expect(storageLocalGet(["ok"])).resolves.toEqual({ ok: 1 });
  });

  it("queries the active tab through callback-only APIs", async () => {
    const tab = { id: 7, url: "https://x.com/romero/status/1" };
    const query = vi.fn((_queryInfo, done: (tabs: chrome.tabs.Tab[]) => void) => done([tab as chrome.tabs.Tab]));
    vi.stubGlobal("chrome", {
      tabs: { query },
    });

    await expect(queryActiveTab()).resolves.toEqual(tab);
    expect(query).toHaveBeenCalledWith({ active: true, currentWindow: true }, expect.any(Function));
  });

  it("rejects runtime messages when lastError is set", async () => {
    const sendMessage = vi.fn((_msg, done: (response: unknown) => void) => done(undefined));
    vi.stubGlobal("chrome", {
      runtime: {
        lastError: { message: "background unavailable" },
        sendMessage,
      },
    });

    await expect(sendRuntimeMessage({ type: "history:page" })).rejects.toThrow("background unavailable");
  });

  // A background that never answers (worker evicted mid-request, a downstream fetch that
  // hangs) must not leave the caller pending forever - the popup and every mounted picker
  // hold state behind these promises.
  it("rejects a runtime message the background never answers", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("chrome", { runtime: { lastError: undefined, sendMessage: vi.fn(() => {}) } });
      const pending = sendRuntimeMessage({ type: "history:page" });
      const assertion = expect(pending).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(RUNTIME_MESSAGE_TIMEOUT_MS + 1);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses alarm APIs when available and no-ops when unavailable", () => {
    const create = vi.fn((_name, _info, done?: () => void) => done?.());
    const addListener = vi.fn();
    vi.stubGlobal("chrome", {
      alarms: { create, onAlarm: { addListener } },
    });

    const listener = vi.fn();
    createAlarm("wake", { periodInMinutes: 5 });
    addAlarmListener(listener);

    expect(create).toHaveBeenCalledWith("wake", { periodInMinutes: 5 }, expect.any(Function));
    expect(addListener).toHaveBeenCalledWith(listener);

    vi.stubGlobal("chrome", {});
    expect(() => createAlarm("missing", { periodInMinutes: 1 })).not.toThrow();
    expect(() => addAlarmListener(listener)).not.toThrow();
  });
});
