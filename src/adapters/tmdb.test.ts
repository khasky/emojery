// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { expectMatchesRegistryHosts } from "./test-fixtures";
import tmdbAdapter, { extractTmdbTitleRef, tmdbTargetFromRef } from "./tmdb";

describe("tmdb adapter", () => {
  it("matches its registry hosts only", () => {
    expectMatchesRegistryHosts(tmdbAdapter, "tmdb");
    // The bare host 301s to `www` and is neither a run host nor a parse host.
    expect(tmdbAdapter.matches("themoviedb.org")).toBe(false);
    expect(tmdbAdapter.matches("www.themoviedb.org.evil.example")).toBe(false);
  });
});

describe("extractTmdbTitleRef", () => {
  it("reads the three surfaces that carry a score row", () => {
    expect(extractTmdbTitleRef("https://www.themoviedb.org/movie/238-the-godfather")).toEqual({ titleId: "movie/238" });
    expect(extractTmdbTitleRef("https://www.themoviedb.org/tv/275102")).toEqual({ titleId: "tv/275102" });
    expect(extractTmdbTitleRef("https://www.themoviedb.org/collection/531241-spider-man-mcu-collection")).toEqual({ titleId: "collection/531241" });
  });

  it("drops the slug, the trailing slash and the language query", () => {
    // TMDB rewrites the slug itself: a wrong one 301s to the numeric id.
    expect(extractTmdbTitleRef("https://www.themoviedb.org/movie/238")).toEqual({ titleId: "movie/238" });
    expect(extractTmdbTitleRef("https://www.themoviedb.org/movie/238-a-completely-different-slug")).toEqual({ titleId: "movie/238" });
    expect(extractTmdbTitleRef("https://www.themoviedb.org/movie/238-the-godfather/")).toEqual({ titleId: "movie/238" });
    expect(extractTmdbTitleRef("https://www.themoviedb.org/movie/238?language=en-US")).toEqual({ titleId: "movie/238" });
  });

  it("reads nothing off a subpage, a season, another entity or another host", () => {
    expect(extractTmdbTitleRef("https://www.themoviedb.org/movie/238-the-godfather/cast")).toBeNull();
    expect(extractTmdbTitleRef("https://www.themoviedb.org/tv/275102/season/1")).toBeNull();
    expect(extractTmdbTitleRef("https://www.themoviedb.org/tv/275102/season/1/episode/1")).toBeNull();
    expect(extractTmdbTitleRef("https://www.themoviedb.org/person/1136406-tom-holland")).toBeNull();
    expect(extractTmdbTitleRef("https://www.themoviedb.org/list/1-the-marvel-universe")).toBeNull();
    expect(extractTmdbTitleRef("https://www.themoviedb.org/movie/not-a-number")).toBeNull();
    expect(extractTmdbTitleRef("https://www.themoviedb.org/")).toBeNull();
    expect(extractTmdbTitleRef("https://evil.example/movie/238")).toBeNull();
    expect(extractTmdbTitleRef(null)).toBeNull();
  });
});

describe("tmdbTargetFromRef", () => {
  it("builds a canonical URL that re-derives its own id", () => {
    const target = tmdbTargetFromRef({ titleId: "tv/1396" });
    expect(target).toEqual({ site: "tmdb", targetId: "tv/1396", url: "https://www.themoviedb.org/tv/1396" });
    expect(extractTmdbTitleRef(target.url)).toEqual({ titleId: "tv/1396" });
  });
});
