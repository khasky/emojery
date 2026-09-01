// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../test/cold-module-reset";

allowColdModuleReset();

const storageLocalGet = vi.fn();
vi.mock("./webext", () => ({
  storageLocalGet: (keys: string[]) => storageLocalGet(keys),
}));

// primePopular registers a chrome.storage.onChanged listener; capture it so a
// test can simulate the background writing a fresh list.
let changeListener: ((changes: Record<string, { newValue?: unknown }>, area: string) => void) | null = null;

beforeEach(() => {
  storageLocalGet.mockReset();
  storageLocalGet.mockResolvedValue({});
  changeListener = null;
  vi.stubGlobal("chrome", {
    storage: {
      onChanged: { addListener: (l: typeof changeListener) => (changeListener = l) },
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Fresh module instance per test - module-level `cachedPopular`/`primed` are singletons.
async function freshModule() {
  vi.resetModules();
  return import("./popular");
}

describe("sanitizePopular", () => {
  it("keeps non-empty, unique, trimmed strings in order", async () => {
    const { sanitizePopular } = await freshModule();
    expect(sanitizePopular(["🔥", " 👍 ", "🔥", "", 5, "❤️"])).toEqual(["🔥", "👍", "❤️"]);
  });

  it("returns null for a non-array or all-unusable input", async () => {
    const { sanitizePopular } = await freshModule();
    expect(sanitizePopular(null)).toBeNull();
    expect(sanitizePopular("🔥")).toBeNull();
    expect(sanitizePopular([])).toBeNull();
    expect(sanitizePopular(["", "   ", 3, {}])).toBeNull();
  });

  it("caps the list length", async () => {
    const { sanitizePopular } = await freshModule();
    const big = Array.from({ length: 500 }, (_, i) => `e${i}`);
    expect(sanitizePopular(big)?.length).toBe(300);
  });
});

describe("getPopularSync / primePopular", () => {
  it("is empty before priming (no baked-in fallback)", async () => {
    const { getPopularSync } = await freshModule();
    expect(getPopularSync()).toEqual([]);
  });

  it("adopts a valid cached list on prime", async () => {
    storageLocalGet.mockResolvedValue({
      popular_v1: { emojis: ["🔥", "👍"], fetchedAt: 1 },
    });
    const { primePopular, getPopularSync } = await freshModule();
    await primePopular();
    expect(getPopularSync()).toEqual(["🔥", "👍"]);
  });

  it("stays empty when the cache is empty or malformed", async () => {
    storageLocalGet.mockResolvedValue({ popular_v1: { emojis: [], fetchedAt: 1 } });
    const { primePopular, getPopularSync } = await freshModule();
    await primePopular();
    expect(getPopularSync()).toEqual([]);
  });

  it("is idempotent - a second prime does not re-read storage", async () => {
    storageLocalGet.mockResolvedValue({
      popular_v1: { emojis: ["🔥"], fetchedAt: 1 },
    });
    const { primePopular } = await freshModule();
    await primePopular();
    await primePopular();
    expect(storageLocalGet).toHaveBeenCalledTimes(1);
  });

  it("tracks a background refresh via storage.onChanged", async () => {
    const { primePopular, getPopularSync } = await freshModule();
    await primePopular();
    changeListener?.({ popular_v1: { newValue: { emojis: ["🎉", "🥳"], fetchedAt: 2 } } }, "local");
    expect(getPopularSync()).toEqual(["🎉", "🥳"]);
  });
});
