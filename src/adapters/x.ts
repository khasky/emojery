// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryAll, queryFirst } from "../shared/dom-query";
import { defineLabelRegistry, STEM, STEM_PARTS, stem } from "./action-labels";
import { defineSiteAdapter, type ScanContext } from "./framework";
import { findSiblingAction, slotAction } from "./placement";
import { directChildSlot, firstAncestor, matchesAny } from "./runtime";
import { parseSiteHref } from "./url-target";

// Logged-in tweets are `article[data-testid="tweet"]`; logged-out X (e.g. an
// incognito visitor on x.com/romero) drops every data-testid and renders the
// tweet as `<article data-tweet-id="...">` (a Tailwind frontend), with a bare
// `<article>` as the final fallback. The candidate filter (`tweetActionRow`)
// keeps only articles that actually hold a Like + action row, so the broad
// fallback is safe.
const TWEET_SELECTORS = ['article[data-testid="tweet"]', "article[data-tweet-id]", "article"];
// The action row is the `role="group"` wrapping the reply/retweet/like/...
// buttons. Logged in it carries an aggregated aria-label ("N replies, M
// reposts, ..."); the focused tweet on a logged-out status page renders those
// counts in a separate bar and leaves the action group with NO aria-label, so
// requiring `[aria-label]` left that post with no picker. `findActionRow` walks
// UP from the Like button, so the bare `div[role="group"]` still resolves to
// the nearest group - the action row - never an unrelated one. (A stricter
// `[aria-label]` variant adds nothing: the bare form matches everything it did.)
const ACTION_ROW_SELECTORS = ['div[role="group"]'];
const LIKE_BUTTON_SELECTORS = ['button[data-testid="like"]', 'button[data-testid="unlike"]', 'button[aria-label$=". Like" i]', 'button[aria-label$=". Unlike" i]'];
const VIEW_LINK_SELECTORS = ['a[aria-label*="View post analytics" i]', 'a[href*="/status/"][href$="/analytics"]', 'a[href*="/status/"][aria-label*="views" i]'];
const BOOKMARK_BUTTON_SELECTORS = ['button[data-testid="bookmark"]', 'button[data-testid="removeBookmark"]', 'button[aria-label$=". Bookmark" i]', 'button[aria-label$=". Remove Bookmark" i]'];
const STATUS_LINK_SELECTORS = ['a[href*="/status/"]'];
const ROW_WALK_DEPTH = 8;
const STATUS_PATH_RE = /^\/([A-Za-z0-9_]{1,20})\/status\/(\d+)(?:\/(?:analytics|photo\/\d+|video\/\d+))?\/?$/;
const STATUS_PHOTO_PATH_RE = /^\/[A-Za-z0-9_]{1,20}\/status\/\d+\/photo\/\d+\/?$/;

const xAdapter = defineSiteAdapter({
  site: "x",
  findCandidates: (ctx) => queryAll<HTMLElement>(ctx.root, TWEET_SELECTORS).filter((tweet) => memoTweetActionRow(ctx, tweet) !== null),
  resolveTarget: (tweet, ctx) => {
    const currentStatus = parseXStatusUrl(location.href);
    // Only the ROOT tweet (first in the document, over ALL tweets) may fall back to the page
    // URL; memo keyed on the scan root - per candidate this was 3 document-wide queries per
    // tweet, O(N^2) per scan.
    const rootTweet = currentStatus ? ctx.memo(ctx.root, () => queryAll<HTMLElement>(ctx.root, TWEET_SELECTORS)[0] ?? null) : null;
    return extractTarget(tweet, {
      currentStatus,
      allowCurrentPageFallback: tweet === rootTweet,
    });
  },
  resolveBinding: (tweet, ctx) => {
    const actionRow = memoTweetActionRow(ctx, tweet);
    if (!actionRow) return null;
    const likeSlot = directChildSlot(actionRow.likeButton, actionRow.row) ?? actionRow.likeButton;
    const placement = findPlacementAnchor(actionRow.row);
    const anchor = placement?.anchor ?? (likeSlot.nextElementSibling instanceof HTMLElement ? likeSlot.nextElementSibling : null) ?? likeSlot;
    const photoView = isCurrentStatusPhotoView();
    return {
      anchor,
      position: placement?.position ?? "after",
      nativeElement: actionRow.likeButton,
      nativeVote: { like: actionRow.likeButton },
      replaceElement: likeSlot,
      wrapper: photoView ? PHOTO_VIEW_WRAPPER : GROW_SLOT_WRAPPER,
    };
  },
  observer: {
    attributeFilter: ["aria-label", "href", "data-testid"],
    navKey: "href",
    navAlwaysTrigger: true,
    linkPrimeSelectors: () => STATUS_LINK_SELECTORS,
  },
});

// One action-row resolution per tweet per scan (memo keyed by the tweet):
// findCandidates and resolveBinding both need it, and each call is 4 selector
// queries plus an ancestor walk.
function memoTweetActionRow(ctx: ScanContext, tweet: HTMLElement): { likeButton: HTMLElement; row: HTMLElement } | null {
  return ctx.memo(tweet, () => tweetActionRow(tweet));
}

function tweetActionRow(tweet: HTMLElement): { likeButton: HTMLElement; row: HTMLElement } | null {
  const likeButton = queryFirst<HTMLElement>(tweet, LIKE_BUTTON_SELECTORS) ?? xLabels.findActionControl(tweet, "like");
  if (!likeButton) return null;
  const row = findActionRow(likeButton, tweet);
  if (!row) return null;
  return { likeButton, row };
}

function findActionRow(likeButton: HTMLElement, tweet: HTMLElement): HTMLElement | null {
  return firstAncestor(likeButton, ROW_WALK_DEPTH, (node) => matchesAny(node, ACTION_ROW_SELECTORS), tweet) ?? findActionClusterRow(likeButton, tweet);
}

// Logged-out X drops the `role="group"` wrapper and every data-testid (verified
// live in incognito on x.com/romero: a bare 518px <div> holding the five action
// slots). Fall back to the lowest ancestor of the Like holding >=3 DISTINCT
// action controls - specific enough that the tweet body can't match.
function findActionClusterRow(likeButton: HTMLElement, tweet: HTMLElement): HTMLElement | null {
  return firstAncestor(likeButton, ROW_WALK_DEPTH, (node) => distinctActionCount(node) >= 3, tweet);
}

function distinctActionCount(el: HTMLElement): number {
  return xLabels.presentKinds(el).size;
}

// LANGUAGE-INDEPENDENT action recognition for logged-out X, which drops every
// data-testid but keeps a stable `data-icon` per action (verified live:
// like=icon-heart, reply=icon-reply, repost=icon-retweet, bookmark=icon-bookmark,
// share=icon-outgoing). Matching the ICON makes EVERY language work identically -
// the stems below are only the fallback for a layout that omits it, which is why
// the registry needs neither a text fallback nor count-summary rejection. Repost
// omits `reshare` (X exposes Repost/Retweet only).
export const X_STEMS = {
  like: STEM.like,
  reply: STEM.reply,
  repost: stem(STEM_PARTS.repost.repost, STEM_PARTS.repost.retweet, STEM_PARTS.repost.repostRu, STEM_PARTS.repost.retweetUk, STEM_PARTS.repost.poshyryt),
  bookmark: STEM.bookmark,
  share: STEM.share,
} as const;

const xLabels = defineLabelRegistry(
  {
    like: { dataIcon: /^icon-heart/i, stems: X_STEMS.like },
    reply: { dataIcon: /^icon-reply/i, stems: X_STEMS.reply },
    repost: { dataIcon: /^icon-(?:retweet|repost)/i, stems: X_STEMS.repost },
    bookmark: { dataIcon: /^icon-bookmark/i, stems: X_STEMS.bookmark },
    share: { dataIcon: /^icon-(?:outgoing|share|upload)/i, stems: X_STEMS.share },
  },
  { useTextFallback: false, readDescendantSvgLabels: false, rejectCountSummary: false },
);

// Where the picker mounts within the action row: before the View (analytics)
// action, else before Bookmark - first by CSS selector, then by localized action
// stem for logged-out X, where the Bookmark testid / count suffix is absent so
// placement still stays "before Bookmark" in every language. Either way the
// matched control resolves to its direct-child slot in the row.
function findPlacementAnchor(row: HTMLElement): { anchor: HTMLElement; position: "before" } | null {
  const sibling = findSiblingAction(row, [slotAction(row, VIEW_LINK_SELECTORS), slotAction(row, BOOKMARK_BUTTON_SELECTORS)]);
  if (sibling) return { anchor: sibling, position: "before" };
  const bookmark = xLabels.findActionControl(row, "bookmark");
  if (!bookmark) return null;
  return { anchor: directChildSlot(bookmark, row) ?? bookmark, position: "before" };
}

// X's action row is a flex container whose leading slots (reply/retweet/like/
// views/bookmark) are all `flex: 1 1 0%` - their even distribution IS the row's
// spacing, so the host gets a matching grow column, styled inline (not by cloning
// a sibling's atomic class) to survive X's class renames. `min-width` must stay
// the flex default `auto`: with `min-width: 0` the column shrinks below our
// counter (far wider than a native icon+count) and the nowrap text spills over
// the next action - the native slots carry their own `min-width: 0` and absorb
// the squeeze instead. The 32px trailing margin reproduces a native slot's gap,
// tuned against live X.
const GROW_SLOT_WRAPPER = { tagName: "div", style: "display: flex; align-items: center; flex: 1 1 0%; margin-inline-end: 32px;" };

// In status photo view the action row is much narrower (~300px) and, verified
// live, `flex-wrap: nowrap` - an "own flex line" wrapper (`flex: 1 0 100%`) then
// monopolizes the row and squeezes every native slot to zero width. Join as an
// equal grow column instead, minus the timeline wrapper's 32px trailing margin:
// the narrow row's space-between distribution supplies the gaps.
const PHOTO_VIEW_WRAPPER = { tagName: "div", style: "display: flex; align-items: center; flex: 1 1 0%;" };

function extractTarget(
  tweet: HTMLElement,
  opts: {
    currentStatus: XStatusRef | null;
    allowCurrentPageFallback: boolean;
  },
): TargetRef | null {
  // This tweet's OWN status ref - from its analytics/timestamp links, EXCLUDING
  // any link inside a nested quoted-tweet card (a quote carries a DIFFERENT
  // status id and must never be read as this tweet's identity).
  const own = findOwnStatusRef(tweet, VIEW_LINK_SELECTORS) ?? findOwnStatusRef(tweet, STATUS_LINK_SELECTORS);

  // On a status DETAIL page, the picker belongs ONLY on the focused post - the
  // tweet whose own id matches the page URL. Replies, conversation parents and
  // quoted tweets are also `article` elements with action rows, but each has a
  // DIFFERENT own id, so they must be dropped. Without this, as X virtualizes
  // the focused tweet out of the DOM on scroll, a reply becomes the first
  // article in the document and (via the page-URL fallback) inherited the
  // focused post's target - so the single picker floated from comment to
  // comment, appearing and disappearing (X "button floats over comments" bug).
  if (opts.currentStatus) {
    if (own) {
      if (own.statusId !== opts.currentStatus.statusId) return null;
      return xTargetFromRef(opts.currentStatus);
    }
    // No own (non-quoted) status link at all - the logged-out focused detail
    // tweet, whose analytics link is absent and whose only `/status/` link can
    // point at embedded content. Only the root (first) article may then adopt
    // the page URL.
    return opts.allowCurrentPageFallback ? xTargetFromRef(opts.currentStatus) : null;
  }

  // Timeline / profile / search feed (no focused status): every tweet resolves
  // to its own id, so each post gets its own picker.
  return own ? xTargetFromRef(own) : null;
}

export function xTargetFromRef(ref: XStatusRef): TargetRef {
  return { site: "x", targetId: ref.statusId, url: ref.url };
}

// The first status ref reachable from `root` via `selectors`, skipping links
// inside a nested quoted-tweet card so a quote's id can't be mistaken for this
// tweet's identity.
function findOwnStatusRef(root: HTMLElement, selectors: readonly string[]): XStatusRef | null {
  for (const link of queryAll<HTMLAnchorElement>(root, selectors)) {
    if (isInQuotedTweet(link, root)) continue;
    const parsed = parseXStatusUrl(link.getAttribute("href") || link.href);
    if (parsed) return parsed;
  }
  return null;
}

// X renders a quoted tweet as a nested clickable card - a `div[role="link"]`
// wrapping the quoted post (its author, text and own timestamp `<a>`). The
// tweet's own timestamp/analytics anchors are NOT wrapped in such a card, so a
// `div[role="link"]` ancestor (below the tweet article) marks a link as
// belonging to the quoted post, not this one.
function isInQuotedTweet(link: Element, tweet: HTMLElement): boolean {
  let node = link.parentElement;
  while (node && node !== tweet) {
    if (node.matches('div[role="link"]')) return true;
    node = node.parentElement;
  }
  return false;
}

export function extractXStatusRef(href: string): XStatusRef | null {
  return parseXStatusUrl(href);
}

interface XStatusRef {
  handle: string;
  statusId: string;
  url: string;
}

function parseXStatusUrl(href: string): XStatusRef | null {
  return parseSiteHref(href, "x", (url) => {
    const match = url.pathname.match(STATUS_PATH_RE);
    const handle = match?.[1];
    const statusId = match?.[2];
    if (!handle || !statusId) return null;
    return {
      handle,
      statusId,
      url: `https://x.com/${handle}/status/${statusId}`,
    };
  });
}

function isCurrentStatusPhotoView(): boolean {
  return STATUS_PHOTO_PATH_RE.test(location.pathname);
}

export default xAdapter;
