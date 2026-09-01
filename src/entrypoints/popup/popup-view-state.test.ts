// SPDX-License-Identifier: GPL-3.0-or-later
//
// The popup shell's decisions, asserted without rendering it. Extension-owned state
// and localStorage only - no supported-site DOM, per CONTRIBUTING.md.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS, mergeSettings, type Settings } from "../../shared/storage";
import { nextViewForKey, rememberView, storedView, TAB_VIEWS, VIEW_LABEL_KEYS, VIEWS, type View } from "./popup-view-state";

const VIEW_KEY = "popup_view_v1";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("storedView / rememberView", () => {
  it("round-trips every view", () => {
    for (const view of VIEWS) {
      rememberView(view);
      expect(storedView()).toBe(view);
    }
  });

  it("falls back to settings for an unknown, empty or absent value", () => {
    expect(storedView()).toBe("settings");
    for (const stored of ["", "queue", "__proto__", "Settings"]) {
      localStorage.setItem(VIEW_KEY, stored);
      expect(storedView()).toBe("settings");
    }
  });

  it("survives a profile with storage blocked, on both the read and the write", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(storedView()).toBe("settings");
    expect(() => rememberView("history")).not.toThrow();
  });
});

describe("nextViewForKey", () => {
  it("walks the tab bar in TAB_VIEWS order and wraps at both ends", () => {
    expect(nextViewForKey("ArrowRight", "settings")).toBe("history");
    expect(nextViewForKey("ArrowDown", "history")).toBe("account");
    expect(nextViewForKey("ArrowLeft", "history")).toBe("settings");
    expect(nextViewForKey("ArrowUp", "settings")).toBe("report");
    expect(nextViewForKey("ArrowRight", "report")).toBe("settings");
  });

  // Debug is a header button, not a tab: the strip must wrap Report back to Settings
  // rather than stepping onto a control that isn't in it.
  it("never lands on Debug, and owns no key while Debug is the open panel", () => {
    for (const key of ["ArrowRight", "ArrowLeft", "ArrowUp", "ArrowDown", "Home", "End"]) {
      expect(nextViewForKey(key, "report")).not.toBe("debug");
      expect(nextViewForKey(key, "debug")).toBeNull();
    }
  });

  it("sends Home/End to the ends regardless of where it starts", () => {
    for (const view of TAB_VIEWS) {
      expect(nextViewForKey("Home", view)).toBe(TAB_VIEWS[0]);
      expect(nextViewForKey("End", view)).toBe(TAB_VIEWS[TAB_VIEWS.length - 1]);
    }
  });

  it("returns null for a key the tab bar does not own, so the caller lets it bubble", () => {
    for (const key of ["Tab", "Enter", " ", "a", "Escape", "PageDown"]) {
      expect(nextViewForKey(key, "settings")).toBeNull();
    }
  });

  it("labels every view", () => {
    for (const view of VIEWS) {
      expect(VIEW_LABEL_KEYS[view]).toBeTruthy();
    }
    expect(Object.keys(VIEW_LABEL_KEYS).sort()).toEqual([...VIEWS].sort());
  });
});

// The merge the popup mirrors every write with. Its bug shape is a settings patch that
// silently drops the per-site toggles, or a second toggle in one batch reverting the first.
describe("mergeSettings, as the popup applies it", () => {
  it("keeps untouched site toggles when a patch carries other fields", () => {
    const base: Settings = mergeSettings(DEFAULT_SETTINGS, { sites: { ...DEFAULT_SETTINGS.sites, github: false } });
    const next = mergeSettings(base, { replaceNative: true });
    expect(next.sites.github).toBe(false);
    expect(next.replaceNative).toBe(true);
  });

  it("composes two patches in order - the second cannot revert the first", () => {
    const once = mergeSettings(DEFAULT_SETTINGS, { replaceNative: true });
    const twice = mergeSettings(once, { reactionAnimations: false });
    expect(twice).toMatchObject({ replaceNative: true, reactionAnimations: false });
  });

  it("lays a pre-hydration patch over the loaded settings, not under them", () => {
    // What App does when a toggle beats the storage read: the load is the base.
    const loaded: Settings = mergeSettings(DEFAULT_SETTINGS, { theme: "dark", enabled: false });
    const preHydration: Partial<Settings> = { enabled: true };
    const hydrated = mergeSettings(loaded, preHydration);
    expect(hydrated.enabled).toBe(true);
    expect(hydrated.theme).toBe("dark");
  });

  it("leaves the base object untouched", () => {
    const base = mergeSettings(DEFAULT_SETTINGS, {});
    const snapshot = JSON.stringify(base);
    mergeSettings(base, { enabled: false, sites: { ...base.sites, x: false } });
    expect(JSON.stringify(base)).toBe(snapshot);
  });
});

describe("VIEWS", () => {
  it("has no duplicates - the arrow walk indexes by value", () => {
    expect(new Set<View>(VIEWS).size).toBe(VIEWS.length);
  });

  it("keeps Debug out of the tab strip while still being a view the popup can show", () => {
    expect(TAB_VIEWS).toEqual(["settings", "history", "account", "report"]);
    expect(VIEWS).toContain("debug");
  });
});
