// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { expectMatchesRegistryHosts } from "./test-fixtures";
import youtubeAdapter, { extractYouTubeVideoRef, resolveSegmentedGroup } from "./youtube";

const VIDEO_ID = "Pjb7tRmjwag";
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

describe("youtube adapter", () => {
  it("matches youtube hosts only", () => {
    expectMatchesRegistryHosts(youtubeAdapter, "youtube");
    expect(youtubeAdapter.matches("youtu.be")).toBe(false);
    // Parse-only, never a run host: the desktop `ytd-*` selectors don't match
    // mobile YouTube's `ytm-*` DOM.
    expect(youtubeAdapter.matches("m.youtube.com")).toBe(false);
  });

  it("extracts canonical video refs", () => {
    expect(extractYouTubeVideoRef(`${VIDEO_URL}&ab_channel=news`)).toEqual({
      videoId: VIDEO_ID,
      url: VIDEO_URL,
    });
    expect(extractYouTubeVideoRef(`https://youtube.com/shorts/${VIDEO_ID}?feature=share`)).toEqual({
      videoId: VIDEO_ID,
      url: VIDEO_URL,
    });
    // A link to m.youtube.com still resolves to the canonical www target
    // (parse-host only - the extension doesn't run there).
    expect(extractYouTubeVideoRef(`https://m.youtube.com/watch?v=${VIDEO_ID}`)).toEqual({ videoId: VIDEO_ID, url: VIDEO_URL });
    expect(extractYouTubeVideoRef("https://example.com/watch?v=Pjb7tRmjwag")).toBeNull();
    expect(extractYouTubeVideoRef("https://www.youtube.com/watch?v=short")).toBeNull();
  });
});

// Generic sentinel elements (no fake supported-site DOM): slot resolution and
// the no-match cases. The real watch/Shorts placement is verified by e2e.
describe("resolveSegmentedGroup - one hide-unit for the native like controls", () => {
  const SELECTORS = { segmented: [".seg"], like: [".like"], dislike: [".dislike"] };

  it("prefers the segmented group as a single unit", () => {
    const row = document.createElement("div");
    const slot = document.createElement("div");
    const seg = document.createElement("div");
    seg.className = "seg";
    slot.appendChild(seg);
    row.appendChild(slot);
    const like = document.createElement("button");
    like.className = "like";
    row.appendChild(like);
    document.body.appendChild(row);

    expect(resolveSegmentedGroup(row, SELECTORS)).toEqual([slot]);
  });

  it("falls back to separate like + dislike slots, deduped and compacted", () => {
    const row = document.createElement("div");
    const like = document.createElement("button");
    like.className = "like";
    const dislike = document.createElement("button");
    dislike.className = "dislike";
    row.append(like, dislike);
    document.body.appendChild(row);

    expect(resolveSegmentedGroup(row, SELECTORS)).toEqual([like, dislike]);
  });

  it("returns only the control that exists, empty when neither does", () => {
    const row = document.createElement("div");
    const like = document.createElement("button");
    like.className = "like";
    row.appendChild(like);
    document.body.appendChild(row);

    expect(resolveSegmentedGroup(row, SELECTORS)).toEqual([like]);
    expect(resolveSegmentedGroup(document.createElement("div"), SELECTORS)).toEqual([]);
  });
});
