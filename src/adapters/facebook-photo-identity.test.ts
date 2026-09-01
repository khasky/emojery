// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Canonical post-identity mining from Facebook's embedded JSON payloads. The
 * shapes are taken from a live capture of one post reached two ways - a
 * `permalink.php?story_fbid=pfbid...` page and a `/photo/?fbid=<media>` viewer -
 * where, crucially, the SAME post is served under a DIFFERENT pfbid per surface.
 * The only convergent identity is the numeric `post_id`, which both surfaces'
 * JSON expose; these tests pin that mapping.
 *
 * The tests feed JSON text straight into the exported `mergeIdentityJsonText`
 * seam - the `<script type="application/json">` document scan that wraps it is
 * live-page behavior, covered by e2e. Model the document as facebook.com so
 * absolute permalinks pass the host gate and `atob` (the encoded-story-id
 * decode) is available.
 * @vitest-environment-options { "url": "https://www.facebook.com/" }
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../test/cold-module-reset";

allowColdModuleReset();

// The identity maps are module-level and accumulate (mirroring a real page that
// only grows) - re-import a fresh module per test so no mapping leaks between
// assertions.
let mergeIdentityJsonText: (text: string) => void;
let canonicalPostIdForPhoto: (photoId: string) => string | null;
let photoIsAmbiguous: (photoId: string) => boolean;
let postUrlForPhoto: (photoId: string) => string | null;

beforeEach(async () => {
  vi.resetModules();
  const mod = await import("./facebook-photo-identity");
  mergeIdentityJsonText = mod.mergeIdentityJsonText;
  canonicalPostIdForPhoto = mod.canonicalPostIdForPhoto;
  photoIsAmbiguous = mod.photoIsAmbiguous;
  postUrlForPhoto = mod.postUrlForPhoto;
});

function ingest(value: unknown): void {
  mergeIdentityJsonText(JSON.stringify(value));
}

const permalink = (pfbid: string, extra = "") => `https://www.facebook.com/permalink.php?story_fbid=${pfbid}&id=61576678289841${extra}`;

describe("canonical post identity (variant B - numeric post_id)", () => {
  it("ties a pfbid story token AND its attachment media to one numeric post id (feed shape)", () => {
    const PFBID = "pfbid0FEEDaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const POST = "100000000000001";
    const MEDIA = "200000000000001";
    ingest({
      __typename: "Story",
      post_id: POST,
      wwwURL: `https://www.facebook.com/zuck/posts/${PFBID}`,
      attachments: [{ media: { __typename: "Photo", id: MEDIA } }],
    });

    expect(canonicalPostIdForPhoto(MEDIA)).toBe(POST);
    expect(postUrlForPhoto(MEDIA)).toContain(PFBID);
  });

  it("maps a photo media id to the post via creation_story (photo-viewer shape, no attachments)", () => {
    const PFBID = "pfbid0VIEWERbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const POST = "100000000000002";
    const MEDIA = "200000000000002";
    ingest({
      __typename: "Photo",
      id: MEDIA,
      creation_story: { post_id: POST, url: permalink(PFBID) },
    });

    expect(canonicalPostIdForPhoto(MEDIA)).toBe(POST);
  });

  it("converges the SAME post to one numeric id across two different per-surface pfbids", () => {
    const POST = "100000000000003";
    const MEDIA = "200000000000003";
    const PFBID_PERMALINK = "pfbid0PERMALINKcccccccccccccccccccccccccccccccccc";
    const PFBID_PHOTO = "pfbid0PHOTOdddddddddddddddddddddddddddddddddddddd";
    // Surface 1 - permalink: a story node (pfbid_permalink) with the post id.
    ingest({ __typename: "Story", post_id: POST, url: permalink(PFBID_PERMALINK) });
    // Surface 2 - photo viewer: the media's creation_story (pfbid_photo) + post id.
    ingest({
      __typename: "Photo",
      id: MEDIA,
      creation_story: { post_id: POST, url: permalink(PFBID_PHOTO) },
    });

    expect(canonicalPostIdForPhoto(MEDIA)).toBe(POST);
  });

  it("parses a multipart @defer stream of newline-delimited JSON objects", () => {
    const POST = "100000000000007";
    const MEDIA = "200000000000007";
    const lineOne = JSON.stringify({ __typename: "Photo", id: MEDIA, creation_story: { post_id: POST, url: permalink("pfbid0STREAMhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh") } });
    mergeIdentityJsonText(`not json prefix\n${lineOne}\n{broken`);

    expect(canonicalPostIdForPhoto(MEDIA)).toBe(POST);
  });

  it("returns null for a media id reshared across two posts (ambiguous)", () => {
    const MEDIA = "200000000000005";
    ingest({
      __typename: "Photo",
      id: MEDIA,
      creation_story: { post_id: "100000000000005", url: permalink("pfbid0RESHAREoneeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") },
    });
    ingest({
      __typename: "Photo",
      id: MEDIA,
      creation_story: { post_id: "100000000000055", url: permalink("pfbid0RESHAREtwoffffffffffffffffffffffffffffffffff") },
    });

    expect(canonicalPostIdForPhoto(MEDIA)).toBeNull();
    expect(photoIsAmbiguous(MEDIA)).toBe(true);
  });

  it("does NOT treat one post seen under different url params as ambiguous", () => {
    const PFBID = "pfbid0SAMEgggggggggggggggggggggggggggggggggggggggg";
    const POST = "100000000000006";
    const MEDIA = "200000000000006";
    ingest({ __typename: "Photo", id: MEDIA, creation_story: { post_id: POST, url: permalink(PFBID) } });
    ingest({
      __typename: "Photo",
      id: MEDIA,
      container_story: { post_id: POST, url: permalink(PFBID, "&comment_id=4607749562840934&__cft__[0]=AZxyz") },
    });

    expect(canonicalPostIdForPhoto(MEDIA)).toBe(POST);
    expect(photoIsAmbiguous(MEDIA)).toBe(false);
    expect(postUrlForPhoto(MEDIA)).toContain(PFBID);
  });

  it("returns null for identities the page never named (graceful fallback)", () => {
    expect(canonicalPostIdForPhoto("299999999999999")).toBeNull();
    expect(postUrlForPhoto("299999999999999")).toBeNull();
  });
});
