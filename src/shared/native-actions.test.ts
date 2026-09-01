// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { DEFAULT_EMOJI_SENTIMENT, FB_REACTIONS, resolveFbReaction, resolveSentiment } from "./native-actions";
import { REACTIONS } from "./reactions";

const { positive: DEFAULT_POSITIVE, negative: DEFAULT_NEGATIVE } = DEFAULT_EMOJI_SENTIMENT;

describe("sentiment defaults", () => {
  it("every default emoji exists in the picker palette", () => {
    for (const emoji of [...DEFAULT_POSITIVE, ...DEFAULT_NEGATIVE]) {
      expect(REACTIONS, `${emoji} missing from REACTIONS`).toContain(emoji);
    }
  });

  it("positive and negative defaults do not overlap and hold no duplicates", () => {
    const all = [...DEFAULT_POSITIVE, ...DEFAULT_NEGATIVE];
    expect(new Set(all).size).toBe(all.length);
  });
});

describe("resolveSentiment", () => {
  const lists = { positive: ["👍"], negative: ["👎"] };

  it("classifies by list membership, everything else neutral", () => {
    expect(resolveSentiment("👍", lists)).toBe("positive");
    expect(resolveSentiment("👎", lists)).toBe("negative");
    expect(resolveSentiment("🤖", lists)).toBe("neutral");
  });

  it("empty lists make everything neutral", () => {
    expect(resolveSentiment("👍", { positive: [], negative: [] })).toBe("neutral");
  });
});

describe("FB reaction mapping", () => {
  it("covers flyout positions 0..6 exactly once", () => {
    expect(FB_REACTIONS.map((r) => r.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("every mapped emoji exists in the picker palette and maps to one reaction only", () => {
    const all = FB_REACTIONS.flatMap((r) => [...r.emojis]);
    expect(new Set(all).size).toBe(all.length);
    for (const emoji of all) {
      expect(REACTIONS, `${emoji} missing from REACTIONS`).toContain(emoji);
    }
  });

  it("resolves canonical and alias emojis, null otherwise", () => {
    expect(resolveFbReaction("👍")?.name).toBe("like");
    expect(resolveFbReaction("❤️")?.name).toBe("love");
    expect(resolveFbReaction("💖")?.name).toBe("love");
    expect(resolveFbReaction("🤗")?.name).toBe("care");
    expect(resolveFbReaction("🤣")?.name).toBe("haha");
    expect(resolveFbReaction("😲")?.name).toBe("wow");
    expect(resolveFbReaction("😭")?.name).toBe("sad");
    expect(resolveFbReaction("🤬")?.name).toBe("angry");
    expect(resolveFbReaction("🤖")).toBeNull();
  });
});
