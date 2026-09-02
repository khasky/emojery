// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { canonicalizeFbUrl, extractPhotoFbid, fbUrlFallbackId, groupStoryPermalinkFromPhotoUrl, hashUrl, isFacebookHost, isGroupStoryPermalink, normalizeCftHref, normalizePhotoHref, normalizePostHref, pcbPostIdFromPhotoUrl } from "./facebook-urls";

describe("isFacebookHost", () => {
  it("accepts only the exact Facebook hosts", () => {
    expect(isFacebookHost("facebook.com")).toBe(true);
    expect(isFacebookHost("www.facebook.com")).toBe(true);
    expect(isFacebookHost("m.facebook.com")).toBe(true);
  });

  it("rejects look-alike and subdomain-spoof hosts", () => {
    expect(isFacebookHost("www.facebook.com.evil.com")).toBe(false);
    expect(isFacebookHost("facebook.evil.com")).toBe(false);
    expect(isFacebookHost("evil.com")).toBe(false);
  });
});

describe("normalizePostHref host gate", () => {
  it("normalizes a genuine Facebook post permalink", () => {
    expect(normalizePostHref("https://www.facebook.com/zuck/posts/1234567890")).toBe("https://www.facebook.com/zuck/posts/1234567890");
    expect(normalizePostHref("https://m.facebook.com/groups/dev/permalink/987654321/")).toBe("https://m.facebook.com/groups/dev/permalink/987654321/");
  });

  it("rejects an off-Facebook URL even when it matches the post pattern", () => {
    // Regression for the release audit: a page-controlled anchor/React prop href
    // such as `https://evil.com/posts/123` passes POST_URL_RE but must NOT become
    // the reaction target URL - the host gate drops it.
    expect(normalizePostHref("https://evil.com/posts/123")).toBeNull();
    expect(normalizePostHref("https://evil.example/permalink/999/")).toBeNull();
    expect(normalizePostHref("https://www.facebook.com.evil.com/posts/123")).toBeNull();
  });

  it("rejects a non-post URL", () => {
    expect(normalizePostHref("https://www.facebook.com/marketplace/")).toBeNull();
  });

  it("does not execute a javascript: URL that smuggles the post pattern", () => {
    expect(normalizePostHref("javascript:/*/posts/*/alert(1)")).toBeNull();
  });
});

// A multi-photo post's `set=pcb.<postId>` is the post's own id - it must survive
// normalization (tracking params and album sets are dropped) so the target can
// key on the post instead of the per-photo media id.
describe("normalizePhotoHref identity sets", () => {
  it("keeps a pcb set and drops tracking params", () => {
    expect(normalizePhotoHref("https://www.facebook.com/photo/?fbid=1504490505051047&set=pcb.1504490531717711&__cft__[0]=AZx")).toBe("https://www.facebook.com/photo/?fbid=1504490505051047&set=pcb.1504490531717711");
    // The no-trailing-slash `/photo` form (verified live) normalizes the same way.
    expect(normalizePhotoHref("https://www.facebook.com/photo?fbid=1504490501717714&set=pcb.1504490531717711")).toBe("https://www.facebook.com/photo/?fbid=1504490501717714&set=pcb.1504490531717711");
  });

  it("drops album sets", () => {
    expect(normalizePhotoHref("https://www.facebook.com/photo/?fbid=123456789&set=a.555000111")).toBe("https://www.facebook.com/photo/?fbid=123456789");
  });
});

// A group unit keys on its story permalink before any photo link - the id that
// gm.-set photos rebuild to and the post page URL carries (group-first fix for
// album-attached photos / avatar photo.php links splitting one post).
describe("isGroupStoryPermalink", () => {
  it("matches numeric group story permalinks, query noise included", () => {
    expect(isGroupStoryPermalink("https://www.facebook.com/groups/1921914684493472/posts/29083810141210559/")).toBe(true);
    expect(isGroupStoryPermalink("https://www.facebook.com/groups/1921914684493472/posts/29083810141210559/?comment_id=290880243&__cft__[0]=AZZv")).toBe(true);
    expect(isGroupStoryPermalink("https://www.facebook.com/groups/dev/permalink/987654321/")).toBe(true);
  });

  it("rejects non-group permalinks, bare group links, and pfbid slugs", () => {
    expect(isGroupStoryPermalink("https://www.facebook.com/zuck/posts/1234567890")).toBe(false);
    expect(isGroupStoryPermalink("https://www.facebook.com/groups/1921914684493472/")).toBe(false);
    expect(isGroupStoryPermalink("https://www.facebook.com/groups/dev/posts/pfbid02SCZNCYjkN4icYTieWwJL33vvDvfftmhbzebFRxPUvb/")).toBe(false);
  });
});

describe("pcbPostIdFromPhotoUrl", () => {
  it("returns the post id from a pcb set", () => {
    expect(pcbPostIdFromPhotoUrl("https://www.facebook.com/photo/?fbid=1504490505051047&set=pcb.1504490531717711")).toBe("1504490531717711");
  });

  it("returns null for album, group, and set-less photo URLs", () => {
    expect(pcbPostIdFromPhotoUrl("https://www.facebook.com/photo/?fbid=123456789&set=a.555000111")).toBeNull();
    expect(pcbPostIdFromPhotoUrl("https://www.facebook.com/photo/?fbid=123456789&set=gm.2154737235134748&idorvanity=42")).toBeNull();
    expect(pcbPostIdFromPhotoUrl("https://www.facebook.com/photo/?fbid=123456789")).toBeNull();
  });
});

describe("groupStoryPermalinkFromPhotoUrl", () => {
  it("rebuilds the group story permalink from a gm-set photo URL", () => {
    expect(groupStoryPermalinkFromPhotoUrl("https://www.facebook.com/photo/?fbid=123456789&set=gm.2154737235134748&idorvanity=1921914684493472")).toBe("https://www.facebook.com/groups/1921914684493472/posts/2154737235134748/");
  });

  it("returns null without a gm set or without the group id", () => {
    expect(groupStoryPermalinkFromPhotoUrl("https://www.facebook.com/photo/?fbid=123456789&set=pcb.555000111")).toBeNull();
    expect(groupStoryPermalinkFromPhotoUrl("https://www.facebook.com/photo/?fbid=123456789&set=gm.2154737235134748")).toBeNull();
    expect(groupStoryPermalinkFromPhotoUrl("https://www.facebook.com/photo/?fbid=123456789")).toBeNull();
  });
});

describe("extractPhotoFbid", () => {
  it("reads a numeric fbid and rejects non-numeric or short values", () => {
    expect(extractPhotoFbid("https://www.facebook.com/photo/?fbid=1504490505051047&set=a.1")).toBe("1504490505051047");
    expect(extractPhotoFbid("https://www.facebook.com/photo/?fbid=abc")).toBeNull();
    expect(extractPhotoFbid("https://www.facebook.com/photo/?fbid=123")).toBeNull();
    expect(extractPhotoFbid("https://www.facebook.com/photo/")).toBeNull();
    expect(extractPhotoFbid("not a url")).toBeNull();
  });
});

describe("normalizeCftHref", () => {
  it("rebuilds the current-page URL around the __cft__ token", () => {
    // jsdom's default URL is http://localhost:3000/ - pathname "/". Literal
    // expected string, not re-derived from the same `location` the code reads.
    expect(normalizeCftHref("https://www.facebook.com/some/link?__cft__[0]=AZxTOKEN")).toBe("https://www.facebook.com/?__cft__[0]=AZxTOKEN");
  });

  it("null without the token or off the Facebook hosts", () => {
    expect(normalizeCftHref("https://www.facebook.com/some/link?fbclid=xyz")).toBeNull();
    expect(normalizeCftHref("https://evil.com/x?__cft__[0]=AZxTOKEN")).toBeNull();
  });
});

// The `url:<hash>` fallback id feeds the wire target key - variant URLs of ONE
// permalink must collapse to one id, and distinct permalinks must not collide.
describe("canonicalizeFbUrl / fbUrlFallbackId", () => {
  it("forces the www host, drops the fragment and tracking params, sorts what stays", () => {
    expect(canonicalizeFbUrl("https://m.facebook.com/story.php?story_fbid=987654321&id=100044213&__tn__=%2CO&fbclid=abc#comments")).toBe("https://www.facebook.com/story.php?id=100044213&story_fbid=987654321");
  });

  it("keeps a bare permalink path unchanged", () => {
    expect(canonicalizeFbUrl("https://www.facebook.com/zuck/posts/1234567890")).toBe("https://www.facebook.com/zuck/posts/1234567890");
  });

  it("returns malformed input unchanged instead of throwing", () => {
    expect(canonicalizeFbUrl("http://[bad")).toBe("http://[bad");
  });

  it("collapses variant URLs of one permalink to one fallback id, keeps distinct posts apart", () => {
    const a = fbUrlFallbackId("https://m.facebook.com/watch/live/?v=555000111&fbclid=track");
    const b = fbUrlFallbackId("https://www.facebook.com/watch/live/?v=555000111#tab");
    const other = fbUrlFallbackId("https://www.facebook.com/watch/live/?v=555000222");
    expect(a).toBe(b);
    expect(a).toMatch(/^url:[a-z0-9]+$/);
    expect(a).not.toBe(other);
  });

  // GOLDEN digests: `url:<hash>` ids are persisted wire keys, so the hash
  // function is a stable contract - a change to it must fail loudly here, not
  // ride through an expectation computed by the same function.
  it("hashUrl and the fallback id match their pinned golden values", () => {
    expect(hashUrl("https://www.facebook.com/zuck/posts/1")).toBe("10hrmud1w0a7vi0i6q2p915b4bpf");
    expect(fbUrlFallbackId("https://www.facebook.com/watch/live/?v=555000111")).toBe("url:05po7jk0nts99m1xqt1pr0lhxqdc");
  });

  it("emits a fixed-width 4-lane digest, so two lanes can never blur together", () => {
    expect(hashUrl("")).toHaveLength(28);
    expect(hashUrl("https://www.facebook.com/groups/1/permalink/2")).toHaveLength(28);
  });

  // A birthday collision merges two unrelated posts under one key, so the digest has to
  // stay collision-free far past the volume a single 32-bit lane could carry.
  it("survives a birthday sweep that the 32-bit digest could not", () => {
    const seen = new Set<string>();
    let generated = 0;
    for (let group = 100_000_000_000_000; generated < 40_000; group++) {
      for (let post = 1; post <= 40 && generated < 40_000; post++) {
        seen.add(hashUrl(`https://www.facebook.com/groups/${group}/permalink/${post}0000000${post}`));
        generated++;
      }
    }
    expect(seen.size).toBe(generated);
  });
});
