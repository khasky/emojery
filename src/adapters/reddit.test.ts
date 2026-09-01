// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import redditAdapter, { extractRedditPostRef } from "./reddit";
import { expectMatchesRegistryHosts } from "./test-fixtures";

const POST_ID = "t3_1tezfl7";
const POST_URL = "https://www.reddit.com/r/coolgithubprojects/comments/1tezfl7/open_source_palantir_on_git/";

describe("reddit adapter", () => {
  it("matches reddit hosts only", () => {
    expectMatchesRegistryHosts(redditAdapter, "reddit");
    expect(redditAdapter.matches("old.reddit.com")).toBe(false);
    expect(redditAdapter.matches("instagram.com")).toBe(false);
  });

  it("extracts comments and gallery post refs", () => {
    expect(extractRedditPostRef(POST_URL)).toMatchObject({
      thingId: POST_ID,
      url: POST_URL,
    });
    expect(extractRedditPostRef("https://www.reddit.com/gallery/1tezfl7")).toEqual({
      thingId: POST_ID,
      url: "https://www.reddit.com/gallery/1tezfl7/",
    });
    expect(extractRedditPostRef("https://example.com/r/x/comments/1tezfl7/y/")).toBeNull();
  });

  it("extracts profile (/user/) post permalinks", () => {
    expect(extractRedditPostRef("https://www.reddit.com/user/shittymorph/comments/1pdm2pn/title/")).toEqual({
      thingId: "t3_1pdm2pn",
      url: "https://www.reddit.com/user/shittymorph/comments/1pdm2pn/title/",
    });
  });
});
