// SPDX-License-Identifier: GPL-3.0-or-later
//
// Guards the emoji palette's internal invariants. The palette is JSON
// (__data__/emoji-categories.json), so the two things the TypeScript type cannot
// prove - that `nameKey` is a real i18n key and that the nav icon is one of the
// category's own emojis - are proven here instead.
import { describe, expect, it } from "vitest";
import enMessages from "./__generated__/messages-en.json";
import { CATEGORIES, REACTIONS } from "./reactions";

describe("CATEGORIES", () => {
  const set = new Set(REACTIONS);

  it("each category's nav icon is one of its own emojis", () => {
    for (const cat of CATEGORIES) {
      expect(cat.emojis).toContain(cat.icon);
      expect(set.has(cat.icon)).toBe(true);
    }
  });

  it("each category's nameKey is a translated i18n key", () => {
    const unknown = CATEGORIES.map((c) => c.nameKey).filter((key) => !(key in enMessages));
    expect(unknown, "category nameKey missing from _locales/en").toEqual([]);
  });

  it("holds no duplicate emoji across categories", () => {
    const seen = new Set<string>();
    const duplicates: string[] = [];
    for (const emoji of REACTIONS) {
      if (seen.has(emoji)) duplicates.push(emoji);
      seen.add(emoji);
    }
    expect(duplicates).toEqual([]);
  });
});
