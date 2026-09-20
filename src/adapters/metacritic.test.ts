// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import metacriticAdapter, { extractMetacriticProductRef, metacriticTargetFromRef } from "./metacritic";
import { expectMatchesRegistryHosts } from "./test-fixtures";

describe("metacritic adapter", () => {
  it("matches its registry hosts only", () => {
    expectMatchesRegistryHosts(metacriticAdapter, "metacritic");
    expect(metacriticAdapter.matches("metacritic.com")).toBe(false);
    expect(metacriticAdapter.matches("www.metacritic.com.evil.example")).toBe(false);
  });
});

describe("extractMetacriticProductRef", () => {
  it("reads the four surfaces that carry a score column", () => {
    expect(extractMetacriticProductRef("https://www.metacritic.com/movie/resident-evil-2026/")).toEqual({ productId: "movie/resident-evil-2026" });
    expect(extractMetacriticProductRef("https://www.metacritic.com/tv/breaking-bad/")).toEqual({ productId: "tv/breaking-bad" });
    expect(extractMetacriticProductRef("https://www.metacritic.com/tv/breaking-bad/season-5/")).toEqual({ productId: "tv/breaking-bad/season-5" });
    expect(extractMetacriticProductRef("https://www.metacritic.com/game/valheim/")).toEqual({ productId: "game/valheim" });
  });

  it("drops the trailing slash and the tracking query", () => {
    expect(extractMetacriticProductRef("https://www.metacritic.com/movie/resident-evil-2026")).toEqual({ productId: "movie/resident-evil-2026" });
    expect(extractMetacriticProductRef("https://www.metacritic.com/movie/resident-evil-2026/?utm_source=x")).toEqual({ productId: "movie/resident-evil-2026" });
  });

  it("reads nothing off a subpage, a browse root, another entity or another host", () => {
    expect(extractMetacriticProductRef("https://www.metacritic.com/movie/resident-evil-2026/critic-reviews/")).toBeNull();
    expect(extractMetacriticProductRef("https://www.metacritic.com/movie/resident-evil-2026/user-reviews/")).toBeNull();
    expect(extractMetacriticProductRef("https://www.metacritic.com/browse/movie/")).toBeNull();
    expect(extractMetacriticProductRef("https://www.metacritic.com/movie/")).toBeNull();
    expect(extractMetacriticProductRef("https://www.metacritic.com/person/milla-jovovich/")).toBeNull();
    // Music sits on an older template with no score column, so it is no target.
    expect(extractMetacriticProductRef("https://www.metacritic.com/music/random-access-memories/daft-punk/")).toBeNull();
    // A season segment belongs to tv alone.
    expect(extractMetacriticProductRef("https://www.metacritic.com/movie/resident-evil-2026/season-1/")).toBeNull();
    // Metacritic's slugs are case-sensitive: a re-cased path is a 404, not the title.
    expect(extractMetacriticProductRef("https://www.metacritic.com/movie/Resident-Evil-2026/")).toBeNull();
    expect(extractMetacriticProductRef("https://www.metacritic.com/")).toBeNull();
    expect(extractMetacriticProductRef("https://evil.example/movie/resident-evil-2026/")).toBeNull();
    expect(extractMetacriticProductRef(null)).toBeNull();
  });
});

describe("metacriticTargetFromRef", () => {
  it("builds a canonical URL that re-derives its own id", () => {
    const target = metacriticTargetFromRef({ productId: "tv/breaking-bad/season-5" });
    expect(target).toEqual({ site: "metacritic", targetId: "tv/breaking-bad/season-5", url: "https://www.metacritic.com/tv/breaking-bad/season-5/" });
    expect(extractMetacriticProductRef(target.url)).toEqual({ productId: "tv/breaking-bad/season-5" });
  });
});
