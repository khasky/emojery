// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cross-script emoji search, driven through the REAL shipped locale data
// (public/emoji-data/*) via a stubbed chrome.runtime.getURL + fetch, exactly as
// the content script fetches it at runtime.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubEmojiDataFetch } from "../test/fixtures";
import { ensureEnLoaded, searchEmojis } from "./emoji-meta";
import { REACTIONS } from "./reactions";

// Treat ❤️ and its VS16-stripped form as the same red heart.
const isRedHeart = (e: string) => e.replace(/️/g, "") === "❤";

beforeEach(() => {
  stubEmojiDataFetch();
});

afterEach(() => vi.unstubAllGlobals());

describe("searchEmojis - cross-script (CJK)", () => {
  it("baseline: the English keyword 'love' surfaces ❤️ once the en map loads", async () => {
    // en is fetched at runtime like every other locale.
    await ensureEnLoaded();
    expect(searchEmojis("love", REACTIONS).some(isRedHeart)).toBe(true);
  });

  it("matches 'love' at word starts only, not as a substring of clover/glove", async () => {
    await ensureEnLoaded();
    const results = searchEmojis("love", REACTIONS);
    expect(results.some(isRedHeart)).toBe(true);
    expect(results).toContain("🤟"); // love-you gesture
    // Substring false positives are gone: "clover", "glove".
    expect(results).not.toContain("🍀"); // four leaf clover
    expect(results).not.toContain("🥊"); // boxing glove
    expect(results).not.toContain("🥎"); // softball (CLDR tag "glove")
  });

  it("finds ❤️ for the Japanese ideograph 愛 once ja/zh load", async () => {
    // First call routes 愛 to ja+zh and kicks off the (mocked) fetch; the maps
    // land asynchronously, so poll until the freshly-loaded data matches.
    searchEmojis("愛", REACTIONS);
    await vi.waitFor(() => expect(searchEmojis("愛", REACTIONS).some(isRedHeart)).toBe(true), { timeout: 3_000 });
  });

  // Every spaceless script the router knows, driven through the real CLDR data:
  // katakana and hangul and thai reach different locale files than the kanji
  // case above, so a broken range or a missing locale key shows up here rather
  // than as "search is empty" for a whole writing system.
  it.each([
    ["katakana (ja)", "ハート"],
    ["hangul (ko)", "하트"],
    ["thai (th)", "หัวใจ"],
    ["simplified chinese (zh)", "爱"],
  ])("finds ❤️ for %s once its locale loads", async (_name, query) => {
    searchEmojis(query, REACTIONS);
    await vi.waitFor(() => expect(searchEmojis(query, REACTIONS).some(isRedHeart)).toBe(true), { timeout: 3_000 });
  });

  // Spaceless scripts get substring matching (there are no word starts to
  // anchor to), which is what makes a one-ideograph query work at all.
  it("matches inside a CJK label, not only at its start", async () => {
    searchEmojis("猫", REACTIONS);
    await vi.waitFor(() => expect(searchEmojis("猫", REACTIONS).length).toBeGreaterThan(0), { timeout: 3_000 });
  });

  it("returns nothing for a query that matches no emoji in any script", () => {
    expect(searchEmojis("zzzzznotanemoji", REACTIONS)).toEqual([]);
  });
});
