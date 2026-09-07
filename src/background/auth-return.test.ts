// SPDX-License-Identifier: GPL-3.0-or-later
//
// Where a sign-in goes when it is done: the origin marker written when a page's
// gate asks for the auth tab, and the return that spends it. The order matters as
// much as the outcome - the auth tab must not close before the user has somewhere
// to land, and a popup sign-in must not inherit some older page's marker.
import { beforeEach, describe, expect, it, vi } from "vitest";

const session: Record<string, unknown> = {};
const tabs = new Map<number, { id: number }>();
const calls: string[] = [];

vi.mock("./debug", () => ({ logBackgroundError: vi.fn() }));
vi.mock("../shared/webext", () => ({
  storageSessionGet: vi.fn(async (keys: string[]) => Object.fromEntries(keys.filter((k) => k in session).map((k) => [k, session[k]]))),
  storageSessionSet: vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(session, items);
  }),
  storageSessionRemove: vi.fn(async (keys: string[]) => {
    for (const key of keys) delete session[key];
  }),
  getTab: vi.fn(async (id: number) => tabs.get(id) ?? null),
  updateTab: vi.fn(async (id: number) => {
    calls.push(`update:${id}`);
  }),
  removeTab: vi.fn(async (id: number) => {
    calls.push(`remove:${id}`);
    tabs.delete(id);
  }),
  focusWindow: vi.fn(async (id: number) => {
    calls.push(`focus:${id}`);
  }),
}));

import { hasAuthOrigin, rememberAuthOrigin, returnToAuthOrigin } from "./auth-return";

const pageSender = (tabId: number, windowId?: number): chrome.runtime.MessageSender => ({ tab: { id: tabId, ...(windowId === undefined ? {} : { windowId }) } as chrome.tabs.Tab });
const popupSender: chrome.runtime.MessageSender = { url: "chrome-extension://ext-id/popup.html" };

beforeEach(() => {
  for (const key of Object.keys(session)) delete session[key];
  tabs.clear();
  calls.length = 0;
  tabs.set(7, { id: 7 });
  tabs.set(9, { id: 9 });
});

describe("auth return target", () => {
  it("remembers the tab a page's gate opened the auth tab from", async () => {
    await rememberAuthOrigin(pageSender(7, 3));
    expect(await hasAuthOrigin()).toBe(true);

    expect(await returnToAuthOrigin(9)).toBe(true);
    expect(calls).toEqual(["focus:3", "update:7", "remove:9"]);
  });

  it("clears an armed marker when the sign-in comes from the popup instead", async () => {
    await rememberAuthOrigin(pageSender(7, 3));
    await rememberAuthOrigin(popupSender);

    expect(await hasAuthOrigin()).toBe(false);
    expect(await returnToAuthOrigin(9)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("keeps the auth tab open when the origin tab was closed meanwhile", async () => {
    await rememberAuthOrigin(pageSender(7, 3));
    tabs.delete(7);

    expect(await hasAuthOrigin()).toBe(false);
    expect(await returnToAuthOrigin(9)).toBe(false);
    // Nothing at all: closing the tab the user is looking at with nowhere to send
    // them is worse than the dead end the return exists to replace.
    expect(calls).toEqual([]);
    expect(tabs.has(9)).toBe(true);
  });

  it("spends the marker, so a second return does nothing", async () => {
    await rememberAuthOrigin(pageSender(7, 3));
    expect(await returnToAuthOrigin(9)).toBe(true);
    calls.length = 0;

    expect(await returnToAuthOrigin(9)).toBe(false);
    expect(calls).toEqual([]);
  });

  it("returns without a window id, where there is only ever one window", async () => {
    await rememberAuthOrigin(pageSender(7));

    expect(await returnToAuthOrigin(9)).toBe(true);
    expect(calls).toEqual(["update:7", "remove:9"]);
  });
});
