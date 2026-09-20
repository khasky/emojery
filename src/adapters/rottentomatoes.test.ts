// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import rottentomatoesAdapter, { extractRottenTomatoesTitleRef, rottentomatoesTargetFromRef } from "./rottentomatoes";
import { expectMatchesRegistryHosts } from "./test-fixtures";

describe("rottentomatoes adapter", () => {
  it("matches its registry hosts only", () => {
    expectMatchesRegistryHosts(rottentomatoesAdapter, "rottentomatoes");
    // The bare host 301s to `www` and is neither a run host nor a parse host.
    expect(rottentomatoesAdapter.matches("rottentomatoes.com")).toBe(false);
    expect(rottentomatoesAdapter.matches("www.rottentomatoes.com.evil.example")).toBe(false);
  });
});

describe("extractRottenTomatoesTitleRef", () => {
  it("reads the four title surfaces", () => {
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/m/the_odyssey_2026")).toEqual({ titleId: "m/the_odyssey_2026" });
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/tv/trespasses")).toEqual({ titleId: "tv/trespasses" });
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/tv/trespasses/s01")).toEqual({ titleId: "tv/trespasses/s01" });
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/tv/trespasses/s01/e02")).toEqual({ titleId: "tv/trespasses/s01/e02" });
  });

  it("folds the case the site routes case-insensitively", () => {
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/m/The_Odyssey_2026")).toEqual({ titleId: "m/the_odyssey_2026" });
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/tv/Trespasses/S01")).toEqual({ titleId: "tv/trespasses/s01" });
  });

  it("drops a trailing slash and the tracking query", () => {
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/m/the_odyssey_2026/")).toEqual({ titleId: "m/the_odyssey_2026" });
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/m/the_odyssey_2026?cmp=RT_Home")).toEqual({ titleId: "m/the_odyssey_2026" });
  });

  it("reads nothing off a subpage, a browse route or another host", () => {
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/m/the_odyssey_2026/reviews")).toBeNull();
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/tv/trespasses/s01/cast-and-crew")).toBeNull();
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/browse/movies_at_home")).toBeNull();
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/celebrity/tom_holland")).toBeNull();
    expect(extractRottenTomatoesTitleRef("https://www.rottentomatoes.com/")).toBeNull();
    expect(extractRottenTomatoesTitleRef("https://evil.example/m/the_odyssey_2026")).toBeNull();
    expect(extractRottenTomatoesTitleRef(null)).toBeNull();
  });
});

describe("rottentomatoesTargetFromRef", () => {
  it("builds a canonical URL that re-derives its own id", () => {
    const target = rottentomatoesTargetFromRef({ titleId: "tv/trespasses/s01" });
    expect(target).toEqual({ site: "rottentomatoes", targetId: "tv/trespasses/s01", url: "https://www.rottentomatoes.com/tv/trespasses/s01" });
    expect(extractRottenTomatoesTitleRef(target.url)).toEqual({ titleId: "tv/trespasses/s01" });
  });
});
