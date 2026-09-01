// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryFirst } from "../shared/dom-query";
import { type Binding, defineSiteAdapter, type ScanContext } from "./framework";
import { findFirstAnchor } from "./placement";
import { compactElements, directChildSlot, matchesAny, safeMatches } from "./runtime";
import { parseSiteHref, urlTargetResolver } from "./url-target";

const ACTION_ROW_SELECTORS = ["#menu.ytd-watch-metadata #top-level-buttons-computed", "ytd-watch-metadata #top-level-buttons-computed", "ytd-menu-renderer #top-level-buttons-computed"];

// Shorts (YouTube's reel format) renders a VERTICAL action column to the right of
// the player - like / dislike / comment / share / more stacked - instead of the
// horizontal watch-page row. Its host element holds those controls as direct
// children, so resolveSegmentedGroup finds the like/dislike there too. (The watch
// row, `#top-level-buttons-computed`, is still in the DOM on a Shorts page but
// collapsed to zero width with no like control, so it never wins the candidate.)
const SHORTS_ACTION_BAR_SELECTORS = ["reel-action-bar-view-model", ".ytwReelActionBarViewModelHost"];

const SHARE_BUTTON_SELECTORS = ['yt-button-view-model button[aria-label^="Share" i]', 'yt-button-view-model button[title^="Share" i]', 'ytd-button-renderer button[aria-label^="Share" i]', 'ytd-button-renderer button[title^="Share" i]', 'button[aria-label^="Share" i]', 'button[title^="Share" i]'];

const SEGMENTED_BUTTON_SELECTORS = ["segmented-like-dislike-button-view-model", ".ytSegmentedLikeDislikeButtonViewModelSegmentedButtonsWrapper", "ytd-segmented-like-dislike-button-renderer", "#segmented-like-button"];

const LIKE_BUTTON_SELECTORS = ["like-button-view-model", "ytd-toggle-button-renderer:first-child", 'button[aria-label^="like this video" i]', 'button[aria-label^="I like this" i]', 'button[title^="I like this" i]'];

const DISLIKE_BUTTON_SELECTORS = ["dislike-button-view-model", "ytd-toggle-button-renderer:nth-child(2)", 'button[aria-label^="Dislike" i]', 'button[aria-label^="I dislike this" i]', 'button[title^="I dislike this" i]'];

const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;

export function youtubeTargetFromRef(ref: { videoId: string; url: string }): TargetRef {
  return { site: "youtube", targetId: ref.videoId, url: ref.url };
}

// The video target is URL-derived (video id from the page URL), independent of the candidate -
// the location-only shape `urlTargetResolver` was built for.
const resolveVideoTarget = urlTargetResolver({
  parse: extractYouTubeVideoRef,
  toTarget: youtubeTargetFromRef,
});

const youtubeAdapter = defineSiteAdapter({
  site: "youtube",
  // Gating here (not in resolveBinding) because findCandidates yields at most
  // ONE row: the accept filter lets the search continue past a row that
  // produces no binding.
  findCandidates: (ctx) => {
    // `accept` is not handed the ctx, so the memo closes over this scan's own.
    const accept = (candidate: HTMLElement): HTMLElement | null => (memoBinding(candidate, ctx) ? candidate : null);
    // Watch row first, Shorts rail second - findFirstAnchor walks the list in
    // priority order, so a page carrying both keeps the watch row.
    const bar = findFirstAnchor(ctx.root, [
      { selectors: ACTION_ROW_SELECTORS, accept },
      { selectors: SHORTS_ACTION_BAR_SELECTORS, accept },
    ]);
    return bar ? [bar] : [];
  },
  // extractYouTubeVideoRef maps a `/shorts/<id>` URL to the same `watch?v=<id>`
  // id, so a Short and the video's watch page converge on one target.
  resolveTarget: resolveVideoTarget,
  resolveBinding: memoBinding,
  // YouTube is a persistent SPA: route changes fire yt-navigate-finish and
  // the metadata panel re-renders on yt-page-data-updated.
  observer: {
    attributeFilter: ["aria-label", "title", "id", "class", "hidden"],
    navKey: "href",
    navAlwaysTrigger: true,
    navEvents: ["yt-navigate-finish"],
    triggerEvents: ["yt-page-data-updated"],
  },
});

// One binding resolution per candidate per scan (memo keyed by the candidate):
// the accept filter above and resolveBinding both need it, and each run is a
// segmented-group resolution plus a share-anchor scan plus the native-vote lookup.
function memoBinding(candidate: HTMLElement, ctx: ScanContext): Binding | null {
  return ctx.memo(candidate, () => (isShortsActionBar(candidate) ? bindingForShortsBar(candidate) : bindingForRow(candidate)));
}

// Length 0 leaves native/replace unset - there is no control to hide.
function assignReplacedControls(binding: Binding, controls: HTMLElement[]): void {
  if (controls.length === 1) {
    binding.nativeElement = controls[0]!;
    binding.replaceElement = controls[0]!;
  } else if (controls.length > 1) {
    binding.nativeElement = controls;
    binding.replaceElement = controls;
  }
}

// The actual <button> for auto-press: the like/dislike selectors match view-model
// wrappers (`like-button-view-model`), so descend to the button inside.
function resolveToggleButton(scope: HTMLElement, selectors: readonly string[]): HTMLElement | null {
  const el = queryFirst<HTMLElement>(scope, selectors);
  if (!el) return null;
  return el.tagName === "BUTTON" ? el : (el.querySelector<HTMLElement>("button") ?? null);
}

function assignNativeVote(binding: Binding, scope: HTMLElement): void {
  const like = resolveToggleButton(scope, LIKE_BUTTON_SELECTORS);
  const dislike = resolveToggleButton(scope, DISLIKE_BUTTON_SELECTORS);
  if (like || dislike) {
    binding.nativeVote = { ...(like ? { like } : {}), ...(dislike ? { dislike } : {}) };
  }
}

// The like/dislike controls to hide as one unit: a segmented group when
// present (a single control), else the separate like + dislike controls. Each
// is resolved to its direct-child slot inside `row`. Mirrors YouTube's two
// layouts; the result feeds nativeElement/replaceElement.
export function resolveSegmentedGroup(
  row: HTMLElement,
  selectors: {
    segmented: readonly string[];
    like: readonly string[];
    dislike: readonly string[];
  },
): HTMLElement[] {
  const segmented = queryFirst<HTMLElement>(row, selectors.segmented);
  if (segmented) {
    return compactElements(directChildSlot(segmented, row) ?? segmented);
  }
  const like = queryFirst<HTMLElement>(row, selectors.like);
  const dislike = queryFirst<HTMLElement>(row, selectors.dislike);
  return compactElements(like ? (directChildSlot(like, row) ?? like) : null, dislike ? (directChildSlot(dislike, row) ?? dislike) : null);
}

// Placement for one action row: hide the like/dislike control(s) (segmented
// group as one unit, else like+dislike together) and mount before the next
// native action (usually Share), or after the like control when no following
// action slot exists.
function bindingForRow(row: HTMLElement): Binding | null {
  const replaceElements = resolveSegmentedGroup(row, {
    segmented: SEGMENTED_BUTTON_SELECTORS,
    like: LIKE_BUTTON_SELECTORS,
    dislike: DISLIKE_BUTTON_SELECTORS,
  });

  const anchor = findShareAnchor(row, replaceElements) ?? replaceElements[replaceElements.length - 1] ?? null;
  if (!anchor) return null;

  const binding: Binding = {
    anchor,
    position: anchor === replaceElements[replaceElements.length - 1] ? "after" : "before",
  };
  assignReplacedControls(binding, replaceElements);
  assignNativeVote(binding, row);
  return binding;
}

function isShortsActionBar(el: HTMLElement): boolean {
  return matchesAny(el, SHORTS_ACTION_BAR_SELECTORS);
}

// Placement for the Shorts vertical action column: the like/dislike controls are
// the unit we replace, and the picker mounts right AFTER them (so it reads as a
// reaction next to the like) - unlike the horizontal watch row, which mounts
// before Share. The column's buttons are direct children of the action bar, so
// resolveSegmentedGroup resolves them here too. Being a vertical icon rail, the
// binding opts the trigger into the round icon-column form (explicit - the
// default is the horizontal row look).
function bindingForShortsBar(bar: HTMLElement): Binding | null {
  const replaceElements = resolveSegmentedGroup(bar, {
    segmented: SEGMENTED_BUTTON_SELECTORS,
    like: LIKE_BUTTON_SELECTORS,
    dislike: DISLIKE_BUTTON_SELECTORS,
  });
  const anchor = replaceElements[replaceElements.length - 1] ?? null;
  if (!anchor) return null;

  const binding: Binding = {
    anchor,
    position: "after",
    triggerLayout: "icon-column",
  };
  assignReplacedControls(binding, replaceElements);
  assignNativeVote(binding, bar);
  return binding;
}

function findShareAnchor(row: HTMLElement, replaceElements: readonly HTMLElement[]): HTMLElement | null {
  const labeled = queryFirst<HTMLElement>(row, SHARE_BUTTON_SELECTORS);
  if (labeled) return directChildSlot(labeled, row) ?? labeled;

  const children = Array.from(row.children) as HTMLElement[];
  const replacementIndexes = replaceElements.map((el) => children.indexOf(el)).filter((index) => index >= 0);
  const start = replacementIndexes.length > 0 ? Math.max(...replacementIndexes) + 1 : 0;

  for (const child of children.slice(start)) {
    if (isButtonSlot(child)) return child;
  }
  return null;
}

function isButtonSlot(el: HTMLElement): boolean {
  return safeMatches(el, "yt-button-view-model, ytd-button-renderer") || !!el.querySelector("button, a");
}

export function extractYouTubeVideoRef(href: string): { videoId: string; url: string } | null {
  return parseSiteHref(href, "youtube", (url) => {
    const videoId = (url.pathname === "/watch" ? url.searchParams.get("v") : null) ?? url.pathname.match(/^\/(?:shorts|embed|live)\/([A-Za-z0-9_-]{11})(?:\/|$)/)?.[1] ?? null;
    if (!videoId || !VIDEO_ID_RE.test(videoId)) return null;
    return {
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
    };
  });
}

export default youtubeAdapter;
