// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import imdbAdapter, { extractImdbTitleRef, imdbTargetFromRef } from "./imdb";
import { expectMatchesRegistryHosts } from "./test-fixtures";

describe("imdb adapter", () => {
  it("matches its registry hosts only", () => {
    expectMatchesRegistryHosts(imdbAdapter, "imdb");
    // `m.imdb.com` 301s to `www` on a desktop browser and is not a run host.
    expect(imdbAdapter.matches("m.imdb.com")).toBe(false);
    expect(imdbAdapter.matches("www.imdb.com.evil.example")).toBe(false);
  });
});

describe("extractImdbTitleRef", () => {
  it("reads the const off a title page, whatever the title is", () => {
    // Movies, series and episodes share the one `/title/tt...` namespace.
    expect(extractImdbTitleRef("https://www.imdb.com/title/tt33764258/")).toEqual({ titleId: "tt33764258" });
    expect(extractImdbTitleRef("https://www.imdb.com/title/tt0903747/")).toEqual({ titleId: "tt0903747" });
    expect(extractImdbTitleRef("https://www.imdb.com/title/tt0959621/")).toEqual({ titleId: "tt0959621" });
  });

  it("drops the trailing slash and the ref query, and folds the const's case", () => {
    expect(extractImdbTitleRef("https://www.imdb.com/title/tt33764258")).toEqual({ titleId: "tt33764258" });
    expect(extractImdbTitleRef("https://www.imdb.com/title/tt33764258/?ref_=fn_al_tt_1")).toEqual({ titleId: "tt33764258" });
    // IMDb serves `/title/TT.../` and points its canonical at the lowercase form.
    expect(extractImdbTitleRef("https://www.imdb.com/title/TT33764258/")).toEqual({ titleId: "tt33764258" });
  });

  it("reads nothing off a subpage, a season list, another entity or another host", () => {
    expect(extractImdbTitleRef("https://www.imdb.com/title/tt33764258/fullcredits/")).toBeNull();
    expect(extractImdbTitleRef("https://www.imdb.com/title/tt33764258/reviews/")).toBeNull();
    expect(extractImdbTitleRef("https://www.imdb.com/title/tt0903747/episodes/")).toBeNull();
    expect(extractImdbTitleRef("https://www.imdb.com/name/nm1297015/")).toBeNull();
    expect(extractImdbTitleRef("https://www.imdb.com/list/ls000004717/")).toBeNull();
    expect(extractImdbTitleRef("https://www.imdb.com/title/nm1297015/")).toBeNull();
    expect(extractImdbTitleRef("https://www.imdb.com/")).toBeNull();
    expect(extractImdbTitleRef("https://evil.example/title/tt33764258/")).toBeNull();
    expect(extractImdbTitleRef(null)).toBeNull();
  });
});

describe("imdbTargetFromRef", () => {
  it("builds a canonical URL that re-derives its own id", () => {
    const target = imdbTargetFromRef({ titleId: "tt0903747" });
    expect(target).toEqual({ site: "imdb", targetId: "tt0903747", url: "https://www.imdb.com/title/tt0903747/" });
    expect(extractImdbTitleRef(target.url)).toEqual({ titleId: "tt0903747" });
  });
});
