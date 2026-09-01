// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { expectMatchesRegistryHosts } from "./test-fixtures";
import threadsAdapter, { extractThreadsPostRef, isMediaViewerPath, isPaintedFill } from "./threads";

const HANDLE = "theromero";
const POST_ID = "DYpmDeHjE1L";
const POST_URL = `https://www.threads.com/@${HANDLE}/post/${POST_ID}`;

describe("threads adapter", () => {
  it("matches threads.com hosts only", () => {
    expectMatchesRegistryHosts(threadsAdapter, "threads");
    expect(threadsAdapter.matches("x.com")).toBe(false);
  });

  it("extracts canonical post refs", () => {
    expect(extractThreadsPostRef(`${POST_URL}?x=1`)).toEqual({
      handle: HANDLE,
      postId: POST_ID,
      url: POST_URL,
    });
    expect(extractThreadsPostRef("https://example.com/@theromero/post/x")).toBeNull();
    expect(extractThreadsPostRef("https://www.threads.com/@theromero")).toBeNull();
  });
});

// Auto-press declines on an unknown state, so an unreadable heart disables the feature. Threads
// localizes the aria-label, so the state comes from the paint - outline unliked, filled liked.
// This is why Threads auto-press works in every language, unlike the label readers in
// github/instagram/facebook (see their "stays unknown on CJK" cases).
describe("isPaintedFill", () => {
  it("reads the fills Threads actually ships", () => {
    // Captured live on a RU feed, both states of the same heart.
    expect(isPaintedFill("rgba(0, 0, 0, 0)")).toBe(false);
    expect(isPaintedFill("color(display-p3 1 0.18 0.25)")).toBe(true);
  });

  it("treats every no-paint spelling as an outline", () => {
    expect(isPaintedFill("none")).toBe(false);
    expect(isPaintedFill("transparent")).toBe(false);
    expect(isPaintedFill("rgba(255, 48, 64, 0.0)")).toBe(false);
    expect(isPaintedFill("color(display-p3 1 0.18 0.25 / 0)")).toBe(false);
  });

  it("does not mistake a colour ending in a zero digit for zero alpha", () => {
    // `rgb(255, 48, 60)` ends in "0)" but is fully opaque red.
    expect(isPaintedFill("rgb(255, 48, 60)")).toBe(true);
    expect(isPaintedFill("rgb(255, 48, 64)")).toBe(true);
    // Opaque black - the trailing-zero regex this parser replaced read the
    // ", 0)" tail as zero alpha and called a painted heart an outline.
    expect(isPaintedFill("rgb(0, 0, 0)")).toBe(true);
  });

  it("stays unknown when the fill is unreadable", () => {
    // Never guess: a wrong `false` presses and likes the post unasked.
    expect(isPaintedFill("")).toBeNull();
    expect(isPaintedFill("   ")).toBeNull();
  });
});

// The lightbox URL freezes the scan (threads.ts suspendScan): mounting behind
// the overlay and tearing down on close produced a visible blink and, when the
// teardown scan lost the race, a stale wrong-post trigger. The path test is the
// pure half; e2e/overlay-freeze.spec.ts pins the live freeze behaviour.
describe("isMediaViewerPath - the /media lightbox overlay", () => {
  it("recognizes a post's media overlay path", () => {
    expect(isMediaViewerPath(`/@${HANDLE}/post/${POST_ID}/media`)).toBe(true);
    expect(isMediaViewerPath(`/@${HANDLE}/post/${POST_ID}/media/`)).toBe(true);
  });

  it("leaves every non-overlay path scanning", () => {
    expect(isMediaViewerPath(`/@${HANDLE}/post/${POST_ID}`)).toBe(false);
    expect(isMediaViewerPath(`/@${HANDLE}/post/${POST_ID}/`)).toBe(false);
    expect(isMediaViewerPath(`/@${HANDLE}`)).toBe(false);
    expect(isMediaViewerPath("/")).toBe(false);
    expect(isMediaViewerPath("/media")).toBe(false);
    // A postId that merely ENDS in "media" is a post page, not the overlay.
    expect(isMediaViewerPath(`/@${HANDLE}/post/${POST_ID}media`)).toBe(false);
  });
});
