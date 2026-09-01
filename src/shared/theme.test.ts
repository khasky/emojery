// SPDX-License-Identifier: GPL-3.0-or-later
//
// detectTheme waterfall in jsdom: inline `color-scheme` IS computed by jsdom,
// inline background-color computes to rgb()/rgba(), and matchMedia does not
// exist (stubbed where the test needs the prefers-color-scheme branch).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../test/cold-module-reset";
import { detectTheme } from "./theme";

allowColdModuleReset();

afterEach(() => {
  document.documentElement.style.cssText = "";
  document.body.style.cssText = "";
  vi.unstubAllGlobals();
});

function stubPrefersDark(matches: boolean): void {
  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches } as MediaQueryList));
}

describe("detectTheme", () => {
  it("defaults to light in a bare document (transparent backgrounds, no matchMedia)", () => {
    expect(detectTheme()).toBe("light");
  });

  it("obeys a winning color-scheme on <html>", () => {
    document.documentElement.style.colorScheme = "dark";
    expect(detectTheme()).toBe("dark");
    document.documentElement.style.colorScheme = "light";
    // A dark body must NOT override an outright light color-scheme.
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    expect(detectTheme()).toBe("light");
  });

  it("falls through an ambiguous 'light dark' color-scheme to luminance", () => {
    document.documentElement.style.colorScheme = "light dark";
    document.body.style.backgroundColor = "rgb(17, 17, 17)";
    expect(detectTheme()).toBe("dark");
  });

  it("classifies body background luminance", () => {
    document.body.style.backgroundColor = "rgb(17, 17, 17)";
    expect(detectTheme()).toBe("dark");
    document.body.style.backgroundColor = "#ffffff";
    expect(detectTheme()).toBe("light");
  });

  it("ignores a transparent body and reads <html> instead", () => {
    // jsdom's default computed background is rgba(0, 0, 0, 0) - alpha 0 is "no paint".
    document.documentElement.style.backgroundColor = "rgb(10, 10, 10)";
    expect(detectTheme()).toBe("dark");
  });

  it("ignores an explicit alpha-0 background", () => {
    document.body.style.backgroundColor = "rgba(0, 0, 0, 0)";
    stubPrefersDark(false);
    expect(detectTheme()).toBe("light");
  });

  it("falls back to prefers-color-scheme when nothing paints", () => {
    stubPrefersDark(true);
    expect(detectTheme()).toBe("dark");
    stubPrefersDark(false);
    expect(detectTheme()).toBe("light");
  });
});

// Fresh module per test: watching/currentTheme/subscribers are module singletons,
// so a shared import would leak observer state across tests.
async function freshTheme(): Promise<typeof import("./theme")> {
  vi.resetModules();
  return import("./theme");
}

describe("watchTheme / getCurrentTheme", () => {
  beforeEach(() => {
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
  });

  it("pushes the current theme to a new subscriber immediately", async () => {
    const { watchTheme } = await freshTheme();
    const cb = vi.fn();
    watchTheme(cb);
    expect(cb).toHaveBeenCalledWith("light");
  });

  it("notifies subscribers when a theme-carrying mutation flips the page dark", async () => {
    const { watchTheme } = await freshTheme();
    const cb = vi.fn();
    watchTheme(cb);
    // The site flips its palette: a `style` mutation on <body>, which the
    // watcher's attributeFilter covers.
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith("dark"));
  });

  it("does not notify when the mutation leaves the theme unchanged", async () => {
    const { watchTheme } = await freshTheme();
    const cb = vi.fn();
    watchTheme(cb);
    cb.mockClear();
    document.body.style.backgroundColor = "rgb(250, 250, 250)"; // still light
    // A subsequent real flip proves the observer batch containing the silent
    // mutation has flushed - no fixed sleep needed for the negative assert.
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith("dark"));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("stops notifying an unsubscribed callback while others still get the flip", async () => {
    const { watchTheme } = await freshTheme();
    const cb = vi.fn();
    const unsubscribe = watchTheme(cb);
    const stillWatching = vi.fn();
    watchTheme(stillWatching);
    cb.mockClear();
    unsubscribe();
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    // The subscribed callback receiving the flip proves the batch flushed; the
    // unsubscribed one must have stayed silent through that same batch.
    await vi.waitFor(() => expect(stillWatching).toHaveBeenCalledWith("dark"));
    expect(cb).not.toHaveBeenCalled();
  });

  it("getCurrentTheme re-detects on every call until a watcher is installed", async () => {
    const { getCurrentTheme } = await freshTheme();
    expect(getCurrentTheme()).toBe("light");
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    expect(getCurrentTheme()).toBe("dark");
  });

  it("getCurrentTheme serves the watcher's cached value once watching", async () => {
    const { getCurrentTheme, watchTheme } = await freshTheme();
    watchTheme(() => {});
    expect(getCurrentTheme()).toBe("light");
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    // The cache updates only via the (async) observer recheck - the synchronous
    // read right after the flip still serves the cached value.
    expect(getCurrentTheme()).toBe("light");
    await vi.waitFor(() => expect(getCurrentTheme()).toBe("dark"));
  });
});

describe("setThemePreference", () => {
  it("overrides page detection, and releases it again on 'system'", async () => {
    const { detectTheme, setThemePreference } = await freshTheme();
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    expect(detectTheme()).toBe("dark");
    setThemePreference("light");
    expect(detectTheme()).toBe("light");
    setThemePreference("system");
    expect(detectTheme()).toBe("dark");
  });

  it("ignores a value that is not one of the two palettes", async () => {
    const { detectTheme, setThemePreference } = await freshTheme();
    document.body.style.backgroundColor = "rgb(0, 0, 0)";
    setThemePreference("sepia" as never);
    expect(detectTheme()).toBe("dark");
  });

  it("notifies watchers so mounted hosts re-stamp", async () => {
    const { setThemePreference, watchTheme } = await freshTheme();
    document.body.style.backgroundColor = "rgb(255, 255, 255)";
    const cb = vi.fn();
    watchTheme(cb);
    cb.mockClear();
    setThemePreference("dark");
    expect(cb).toHaveBeenCalledWith("dark");
    // Same preference again is a no-op, not a repeat notification.
    setThemePreference("dark");
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("applyDocumentTheme", () => {
  it("stamps the forced palette, and the browser preference under 'system'", async () => {
    const { applyDocumentTheme } = await freshTheme();
    applyDocumentTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    stubPrefersDark(true);
    applyDocumentTheme("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
    stubPrefersDark(false);
    applyDocumentTheme("system");
    expect(document.documentElement.dataset.theme).toBe("light");
  });
});
