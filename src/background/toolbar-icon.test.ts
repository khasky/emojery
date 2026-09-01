// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/webext", () => ({ setToolbarIcon: vi.fn() }));

import { setToolbarIcon } from "../shared/webext";
import { applyToolbarIconForTab, isSupportedTabUrl } from "./toolbar-icon";

describe("isSupportedTabUrl - toolbar icon color gate", () => {
  it("recognizes supported run-hosts", () => {
    expect(isSupportedTabUrl("https://x.com/home")).toBe(true);
    expect(isSupportedTabUrl("https://www.reddit.com/r/all")).toBe(true);
    expect(isSupportedTabUrl("https://threads.com/@someone")).toBe(true);
    expect(isSupportedTabUrl("https://github.com/khasky/emojery")).toBe(true);
    // Facebook's mobile host - a run host, so mobile browsers get the colored icon.
    expect(isSupportedTabUrl("https://m.facebook.com/zuck")).toBe(true);
  });

  it("greys out unsupported or unreadable URLs", () => {
    expect(isSupportedTabUrl("https://example.com/")).toBe(false);
    // A parse-only host is not a run host: no content script, so no color.
    expect(isSupportedTabUrl("https://m.youtube.com/watch?v=x")).toBe(false);
    // A redacted url (no host permission) is the extension's own signal that the
    // page is unsupported - must resolve to greyscale, not throw.
    expect(isSupportedTabUrl(undefined)).toBe(false);
    expect(isSupportedTabUrl("not a url")).toBe(false);
    expect(isSupportedTabUrl("chrome://extensions")).toBe(false);
  });
});

describe("applyToolbarIconForTab - per-tab icon choice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function lastIconDetails(): chrome.action.TabIconDetails {
    const call = vi.mocked(setToolbarIcon).mock.calls[0];
    expect(call).toBeDefined();
    return call![0];
  }

  // All three variants resolve their pre-decoded frames asynchronously; jsdom
  // has no OffscreenCanvas, so every case lands on the packaged-path fallback.
  it("shows the homepage icon on the extension's own site", async () => {
    applyToolbarIconForTab(7, "https://emojery.app/faq");
    await vi.waitFor(() => expect(setToolbarIcon).toHaveBeenCalledTimes(1));
    const details = lastIconDetails();
    expect(details.tabId).toBe(7);
    expect((details.path as Record<number, string>)[16]).toBe("icons/icon-home-16.png");
  });

  it("shows the full-color icon on a supported site", async () => {
    applyToolbarIconForTab(3, "https://x.com/home");
    await vi.waitFor(() => expect(setToolbarIcon).toHaveBeenCalled());
    const details = lastIconDetails();
    expect(details.tabId).toBe(3);
    expect((details.path as Record<number, string>)[48]).toBe("icons/icon-48.png");
  });

  it("falls back to the color icon when greyscale can't be produced (never blank)", async () => {
    applyToolbarIconForTab(9, "https://example.com/");
    await vi.waitFor(() => expect(setToolbarIcon).toHaveBeenCalled());
    const details = lastIconDetails();
    expect(details.tabId).toBe(9);
    expect((details.path as Record<number, string>)[128]).toBe("icons/icon-128.png");
    expect("imageData" in details).toBe(false);
  });

  it("treats a redacted (unreadable) url as unsupported, not the homepage", async () => {
    applyToolbarIconForTab(1, undefined);
    await vi.waitFor(() => expect(setToolbarIcon).toHaveBeenCalled());
    expect((lastIconDetails().path as Record<number, string>)[16]).toBe("icons/icon-16.png");
  });
});
