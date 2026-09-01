// SPDX-License-Identifier: GPL-3.0-or-later
//
// Browser-tag -> emoji-locale routing, driven through the REAL shipped
// public/emoji-data/* via a stubbed chrome.runtime.getURL + fetch, exactly as
// the content script resolves it at runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../test/cold-module-reset";
import { stubEmojiDataFetch } from "../test/fixtures";

allowColdModuleReset();

// CLDR red-heart labels; distinct per script, which is what makes the routing observable.
const SIMPLIFIED_HEART = "红心";
const TRADITIONAL_HEART = "愛心";

let fetchedKeys: string[] = [];

beforeEach(() => {
  // The module caches the resolved primary locale, so each case needs a fresh copy.
  vi.resetModules();
  fetchedKeys = stubEmojiDataFetch();
});

afterEach(() => vi.unstubAllGlobals());

async function heartLabelFor(tag: string): Promise<string> {
  vi.stubGlobal("navigator", { languages: [tag] });
  const { ensureLocaleLoaded, getEmojiLabel } = await import("./emoji-meta");
  await ensureLocaleLoaded();
  return getEmojiLabel("❤️");
}

describe("emoji locale routing", () => {
  it.each(["zh-TW", "zh-HK", "zh-MO", "zh-Hant", "zh-Hant-TW"])("routes %s to the shipped Traditional data", async (tag) => {
    await expect(heartLabelFor(tag)).resolves.toBe(TRADITIONAL_HEART);
    expect(fetchedKeys).toContain("zh-hant");
  });

  it("still routes zh-CN to the Simplified data", async () => {
    await expect(heartLabelFor("zh-CN")).resolves.toBe(SIMPLIFIED_HEART);
    expect(fetchedKeys).toContain("zh");
  });

  it("still falls back to the base language for an unshipped region tag", async () => {
    await expect(heartLabelFor("de-AT")).resolves.toBe("rotes Herz");
    expect(fetchedKeys).toContain("de");
  });

  // The popup imports getEmojiLabel/searchEmojis and nothing else from this module -
  // ensureLocaleLoaded is the picker's call. An English-only kick-off here left every
  // shipped non-English locale reading the CLDR English name in the popup.
  it("loads the browser locale from a bare getEmojiLabel call, with no ensureLocaleLoaded", async () => {
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    const { getEmojiLabel } = await import("./emoji-meta");
    getEmojiLabel("❤️");
    await vi.waitFor(() => expect(getEmojiLabel("❤️")).toBe("rotes Herz"), { timeout: 3_000 });
  });

  // Search loads a locale as a "search-extra"; asking for that same locale as the
  // primary afterwards has to promote the settled map, not hand it back untouched.
  it("promotes a locale that already settled as a search-extra to the primary", async () => {
    vi.stubGlobal("navigator", { languages: ["en-US"] });
    const { ensureLocaleLoaded, getEmojiLabel, searchEmojis } = await import("./emoji-meta");
    const { REACTIONS } = await import("./reactions");
    // Only the ru data tags anything "любовь" (uk does not), so a hit proves ru settled -
    // otherwise the promotion below would run through the inflight path instead.
    searchEmojis("любовь", REACTIONS);
    await vi.waitFor(() => expect(searchEmojis("любовь", REACTIONS).length).toBeGreaterThan(0), { timeout: 3_000 });

    vi.stubGlobal("navigator", { languages: ["ru-RU"] });
    await ensureLocaleLoaded();
    expect(getEmojiLabel("❤️")).toBe("алое сердце");
  });

  // The locale load is memoized by key. A fetch that loses the race against
  // service-worker start resolves null, and memoizing THAT stranded the browser
  // locale for the page's lifetime - labels fell back to English forever.
  it("retries a locale whose first fetch failed instead of memoizing the failure", async () => {
    const servesFromDisk = globalThis.fetch;
    let deFailed = false;
    vi.stubGlobal("fetch", (...args: Parameters<typeof fetch>) => {
      if (!deFailed && String(args[0]).includes("emoji-data/de.json")) {
        deFailed = true;
        return Promise.reject(new Error("worker not ready"));
      }
      return servesFromDisk(...args);
    });
    vi.stubGlobal("navigator", { languages: ["de-DE"] });
    const { ensureLocaleLoaded, getEmojiLabel } = await import("./emoji-meta");

    await ensureLocaleLoaded();
    expect(deFailed).toBe(true);
    expect(getEmojiLabel("❤️")).not.toBe("rotes Herz"); // English floor, the lost race

    await ensureLocaleLoaded();
    expect(getEmojiLabel("❤️")).toBe("rotes Herz");
  });
});
