// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { matchPatternsForSite } from "../shared/sites";
import { broadcastVoteDelta } from "./vote-sync";

const target = {
  site: "reddit" as const,
  targetId: "t3_abc",
  url: "https://www.reddit.com/r/x/comments/abc/",
};
const delta = { target, reaction: "👍", prevReaction: null };

interface ChromeStub {
  tabs: {
    query: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
  };
  runtime: { lastError?: { message?: string } };
}

let chromeStub: ChromeStub;

function setChrome(stub: ChromeStub): void {
  (globalThis as { chrome?: unknown }).chrome = stub;
}

beforeEach(() => {
  chromeStub = {
    tabs: {
      query: vi.fn(),
      sendMessage: vi.fn((_tabId: number, _msg: unknown, cb?: (r?: unknown) => void) => cb?.(undefined)),
    },
    runtime: {},
  };
  setChrome(chromeStub);
});

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.restoreAllMocks();
});

describe("broadcastVoteDelta - cross-tab fan-out (SW broker)", () => {
  it("sends the delta to every supported tab except the originating one", async () => {
    chromeStub.tabs.query.mockImplementation((_q: unknown, cb: (tabs: chrome.tabs.Tab[]) => void) => cb([{ id: 1 }, { id: 2 }, { id: 3 }] as chrome.tabs.Tab[]));

    await broadcastVoteDelta(2 /* sender tab - must be skipped */, delta);

    const tabIds = chromeStub.tabs.sendMessage.mock.calls.map((c) => c[0]);
    expect(tabIds).toEqual([1, 3]);
    for (const call of chromeStub.tabs.sendMessage.mock.calls) {
      expect(call[1]).toEqual({ type: "voteSync", ...delta });
    }
  });

  // The delta names one target, and only a tab on that target's site can hold a mount for
  // it. Querying every supported host instead would hand the reacted-to URL to content
  // scripts with no listener for it - asserted as an exact set, since a superset passes any
  // "contains the right patterns" check.
  it("scopes the tab query to the target site's match patterns alone", async () => {
    chromeStub.tabs.query.mockImplementation((_q: unknown, cb: (tabs: chrome.tabs.Tab[]) => void) => cb([]));

    await broadcastVoteDelta(undefined, delta);

    const queryInfo = chromeStub.tabs.query.mock.calls[0]![0] as chrome.tabs.QueryInfo;
    expect(queryInfo.url).toEqual(matchPatternsForSite(target.site));
    expect(queryInfo.url).not.toEqual(expect.arrayContaining(matchPatternsForSite("github")));
  });

  it("swallows a per-tab sendMessage failure (tab without our content script)", async () => {
    chromeStub.tabs.query.mockImplementation((_q: unknown, cb: (tabs: chrome.tabs.Tab[]) => void) => cb([{ id: 1 }, { id: 2 }] as chrome.tabs.Tab[]));
    // Tab 1 has no receiver, so chrome sets lastError; the wrapper rejects and the
    // fan-out must swallow it and still message tab 2.
    chromeStub.tabs.sendMessage.mockImplementation((tabId: number, _msg: unknown, cb?: (r?: unknown) => void) => {
      if (tabId === 1) chromeStub.runtime.lastError = { message: "no receiver" };
      else delete chromeStub.runtime.lastError;
      cb?.(undefined);
    });

    await expect(broadcastVoteDelta(undefined, delta)).resolves.toBeUndefined();
    expect(chromeStub.tabs.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("no-ops when the tab query throws", async () => {
    chromeStub.tabs.query.mockImplementation(() => {
      throw new Error("boom");
    });

    await expect(broadcastVoteDelta(1, delta)).resolves.toBeUndefined();
    expect(chromeStub.tabs.sendMessage).not.toHaveBeenCalled();
  });

  it("no-ops gracefully when chrome.tabs is unavailable", async () => {
    setChrome({ runtime: {} } as unknown as ChromeStub);
    await expect(broadcastVoteDelta(1, delta)).resolves.toBeUndefined();
  });
});
