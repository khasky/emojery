// SPDX-License-Identifier: GPL-3.0-or-later
//
// Facebook adapter wiring: the scan/observe spec, the post-container search that
// turns an accepted Like into the element the target is mined from, and the
// per-scan bookkeeping (action memo, shared-photo collision handling, photo
// click context). The two halves it orchestrates live next door -
// facebook-post-row.ts decides WHICH control is a post Like, facebook-target.ts
// decides WHAT that post is.

import { queryAll, queryFirst } from "../shared/dom-query";
import {
  actionLabel,
  actionRowSlot,
  fbLikePressed,
  findFacebookVisualActionSlot,
  findFbReactionsMenu,
  findLocalStoryContainer,
  isFilledChipRow,
  isInMessengerThread,
  isInNestedArticle,
  isNonPostActionRow,
  isPostActionLikeButton,
  looksLikeCommentRow,
  MODAL_SELECTOR,
  REEL_ACTION_COLUMN_DEPTH,
  resetPostActionLikeCache,
  rowHasPostSibling,
  SCAN_SELECTORS,
  widenToPostUnit,
} from "./facebook-post-row";
import { extractTarget, findGroupStoryPermalinkNear, recordClickedPhotoStory } from "./facebook-target";
import { currentPagePostUrl, extractPhotoFbid, isStandalonePhotoViewerPage, isStandaloneReelViewerPage, normalizePhotoHref } from "./facebook-urls";
import { defineSiteAdapter, type ScanContext } from "./framework";
import { lazyHoverPriming } from "./observer-plugins";
import { ancestors, closestAny, orderModalFirst } from "./runtime";
import type { ObserverPlugin } from "./scan-observer";
import { isRenderableInPageLayout } from "./visual-action-row";

// Re-exports so the tests reach the URL / target / label helpers through the
// adapter they exercise. The e2e auto-press probes consume only the label
// helpers on the first line; the URL/target lines serve facebook.test.ts alone.
export { COMPOSER_ACTION_STEM, FB_LOCALIZED_ACTION_LABELS, FB_REACTION_MENU_ARIA, FB_REMOVE_RE, FB_STEMS, fbLikeLabelPressed } from "./facebook-post-row";
export { clickedPhotoStoryUrls, facebookTarget, targetFromPhotoUrl, targetFromWatchUrl } from "./facebook-target";
export { extractFbId, fbUrlFallbackId, groupStoryPermalinkFromPhotoUrl } from "./facebook-urls";

// A real post-permalink href contains one of these path/query shapes. Facebook
// can render timestamp anchors as `?__cft__=...` placeholders until hover/focus,
// so placeholder hrefs intentionally do not match. Photo-viewer links (`/photo/`,
// `/photo.php`, bare `?fbid=`) are deliberately NOT post permalinks: the lightbox
// is not a post, and capturing those URLs saved spurious `.../photo/` reaction
// entries. Real photo posts still resolve via their `/posts/...` date link.
const POST_LINK_SELECTORS = ['a[href*="/posts/"]', 'a[href*="/permalink/"]', 'a[href*="story_fbid="]', 'a[href*="/videos/"]', 'a[href*="/reel/"]', 'a[href*="/story.php"]'];

const LAZY_LINK_SELECTOR = 'a[role="link"], a[href*="__cft__"], a[href*="__tn__"]';

const POST_CONTAINER_SELECTORS = ['[role="article"]', '[data-pagelet^="FeedUnit"]'];

interface ActionMatch {
  slot: HTMLElement;
  row: HTMLElement | null;
  /** Set when the action "row" is the reel viewer's VERTICAL column - the
   *  binding then opts the trigger into the round icon-column form. */
  rail?: boolean;
  /** Set when the match came from the language-blind geometry fallback rather
   *  than a readable action label - such a match must also prove a real post
   *  container (see findPostContainer). */
  geometry?: boolean;
}

function photoClickContextCapture(): ObserverPlugin {
  return {
    attach() {
      const onClick = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const anchor = target.closest<HTMLAnchorElement>("a[href]");
        if (!anchor) return;
        const photoUrl = normalizePhotoHref(anchor.getAttribute("href") || anchor.href);
        if (!photoUrl) return;
        const fbid = extractPhotoFbid(photoUrl);
        if (!fbid) return;
        // Outside a scan, so the memo holds the last scan's verdicts - stale by
        // now if the user reacted since. widenToPostUnit reads it heavily.
        resetPostActionLikeCache();
        const story = findGroupStoryPermalinkNear(widenToPostUnit(anchor, anchor), null);
        if (story) recordClickedPhotoStory(fbid, story);
      };
      document.addEventListener("click", onClick, true);
      return () => document.removeEventListener("click", onClick, true);
    },
  };
}

const facebookAdapter = defineSiteAdapter({
  site: "facebook",
  // Global [role="button"] scan. The action row sometimes renders in a sibling
  // React subtree, not inside the post's [role="article"], so searching all
  // buttons and walking up to a container is symmetric across layouts.
  findCandidates: ({ root }) => {
    // First callback of every scan: the verdict memo must not outlive a pass.
    resetPostActionLikeCache();
    return orderModalFirst(queryAll<HTMLElement>(root, SCAN_SELECTORS));
  },
  resolveTarget: (btn, ctx) => {
    const action = actionFor(btn, ctx);
    if (!action) return null;
    const container = findPostContainer(btn, action.row, action.geometry ?? false);
    if (!container) return null;
    const target = extractTarget(container, action.row);
    // Two reshares of the same image both fall back to the shared photo id before
    // their date links hydrate, colliding on ONE `photo:<id>` target - the
    // per-target dedupe would drop the second post's picker (verified live: two
    // group posts attaching the same two photos). The embedded-`<script>`
    // ambiguity map (photoIsAmbiguous) only fixes this once BOTH stories are in
    // the page's SSR'd JSON; until then, re-resolve the colliding post with the
    // shared photo skipped so it keys on its own per-post CFT permalink and still
    // mounts. Skipped while a dialog is open so a post shown in both the feed and
    // an open modal still dedupes to one picker (the foreground copy).
    if (target && ctx.seenTargets.has(target.targetId) && !hasOpenDialog()) {
      // Only a collision across two DIFFERENT containers is the shared-photo
      // case; the SAME container colliding means one post matched twice -
      // re-keying would mount a second picker under a divergent key, so return
      // the duplicate and let the per-target dedupe drop it.
      if (targetContainers(ctx).get(target.targetId) === container) return target;
      const distinct = extractTarget(container, action.row, { skipSharedPhoto: true });
      if (distinct && !ctx.seenTargets.has(distinct.targetId)) {
        targetContainers(ctx).set(distinct.targetId, container);
        return distinct;
      }
      return target;
    }
    if (target) targetContainers(ctx).set(target.targetId, container);
    return target;
  },
  resolveBinding: (btn, ctx) => {
    const action = actionFor(btn, ctx);
    if (!action) return null;
    // The action row is a horizontal flex container; anchor on the Like column
    // wrapper so the picker becomes a sibling flex item between Like and Comment
    // (inserting after the button itself would render it BELOW the Like).
    const anchor = action.slot;
    return {
      anchor,
      position: "after",
      nativeElement: btn,
      // The Like button both presses plain Like and (on hover) opens the
      // 7-reaction flyout the trigger engine drives for exact emoji matches.
      nativeVote: {
        like: btn,
        likePressed: () => fbLikePressed(btn),
        reactionMenu: { trigger: btn, kind: "facebook" as const, findMenu: findFbReactionsMenu },
      },
      replaceElement: anchor,
      // On a page opened to ONE post (permalink/photo/reel viewer) a long post can
      // push the action row below the fold, where the viewport-deferred mount reads
      // as "no reaction button". Feeds keep the lazy default.
      ...(isOnPostDetailPage() ? { mountImmediately: true } : {}),
      // The reel viewer's vertical action column takes the round icon-column
      // trigger form; ordinary (horizontal) action rows keep the default.
      ...(action.rail ? { triggerLayout: "icon-column" as const } : {}),
    };
  },
  // No History-API hook - Facebook feeds mutate in place. Beyond the standard
  // mutation watch (aria-label/href) it primes lazy date-link permalinks on a
  // trusted hover/focus and records which post a photo was opened from.
  // The hover must be the USER's: a link is deliberately NOT synthetically
  // hovered, because Facebook isTrusted-gates the hydration (verified live -
  // synthetic events do NOT resolve the href) and they only pop FB's date
  // tooltip over the posts below. The plugin just re-scans after a real one.
  observer: {
    navKey: null,
    attributeFilter: ["aria-label", "href"],
    plugins: [lazyHoverPriming({ selector: LAZY_LINK_SELECTOR }), photoClickContextCapture()],
  },
});

function actionFor(btn: HTMLElement, ctx: ScanContext): ActionMatch | null {
  return ctx.memo(btn, () => resolvePostAction(btn));
}

// Per-scan map: targetId -> the container that produced it. Lets the shared-photo
// handler above tell two DIFFERENT posts falling back to one photo id (re-key the
// second) apart from one post matching twice (same container - a true duplicate).
const TARGET_CONTAINERS_KEY = {};

function targetContainers(ctx: ScanContext): Map<string, HTMLElement> {
  return ctx.memo(TARGET_CONTAINERS_KEY, () => new Map<string, HTMLElement>());
}

// A page opened to engage with ONE post - permalink / photo viewer / reel
// viewer - as opposed to a feed; the action row is often below the fold there.
function isOnPostDetailPage(): boolean {
  return currentPagePostUrl() !== null || isStandalonePhotoViewerPage() || isStandaloneReelViewerPage();
}

function resolvePostAction(btn: HTMLElement): ActionMatch | null {
  // Structural comment rejection FIRST - covers every branch below (labeled,
  // reel, geometry). See isInNestedArticle for why the label guards alone
  // cannot keep a comment's reaction cluster out.
  if (isInNestedArticle(btn)) return null;
  if (isPostActionLikeButton(btn)) {
    // The Messenger popup's composer toolbar pairs a thumbs-up Like with a Send
    // button, which reads as a post Like - but a conversation is never a post.
    if (isInMessengerThread(btn)) return null;
    const slot = actionRowSlot(btn);
    if (!slot) return null;
    const row = slot.parentElement;
    if (row && isNonPostActionRow(row)) return null;
    return { slot, row };
  }

  // Reel viewer: the controls are a VERTICAL column (Like/Comment/Share stacked)
  // whose Comment/Share sit beyond the shallow sibling window checked above, and
  // the geometry fallback below is tuned for horizontal rows. Accept the reel's
  // Like by its action COLUMN instead: a shallow actionRowSlot carrying
  // Comment/Share. The shallow depth + Comment/Share requirement keep it off
  // comment-row Likes (which pair with Reply, never Comment/Share).
  if (isStandaloneReelViewerPage() && actionLabel(btn) === "Like" && isRenderableInPageLayout(btn) && !isInMessengerThread(btn)) {
    const slot = actionRowSlot(btn, REEL_ACTION_COLUMN_DEPTH);
    const row = slot?.parentElement ?? null;
    if (slot && row && rowHasPostSibling(row) && !isNonPostActionRow(row)) {
      return { slot, row, rail: true };
    }
  }

  // The geometry fallback exists ONLY for locales whose labels we can't read
  // (see findFacebookVisualActionSlot). A readable label is either the post Like
  // (handled above) or a recognized non-Like action - never a reason to run the
  // expensive per-ancestor getBoundingClientRect sweep. Gating on unreadable
  // labels is the other half of the crowded-feed delay fix: the sweep no longer
  // runs for every comment Like / Comment / Share / "See more" button.
  if (actionLabel(btn) !== null) return null;

  const visual = findFacebookVisualActionSlot(btn);
  if (visual?.index !== 0) return null;
  // A row we CAN read as plainly a comment row (Reply, no Comment/Share/Send) is
  // still rejected - otherwise a wide localized comment row passes the geometry
  // test and the trigger lands on comments.
  if (looksLikeCommentRow(visual.row)) return null;
  // The Messenger popup's per-message hover actions / header button rows can
  // also satisfy the geometry test; reject anything inside a chat thread.
  if (isInMessengerThread(btn)) return null;
  if (isNonPostActionRow(visual.row)) return null;
  if (isFilledChipRow(visual.slots)) return null;
  return { slot: visual.slot, row: visual.row, geometry: true };
}

// Feed-path ceiling: how far up from the button to look for an ancestor holding
// a post/permalink link before giving up.
const POST_CONTAINER_WALK_DEPTH = 20;

// Find the post container surrounding the button: standard containers
// (POST_CONTAINER_SELECTORS) first, else walk up to an ancestor holding a
// date/permalink link - logged-in feed layouts can render the action row outside
// `[role="article"]` but adjacent to the post body that holds the date link.
function findPostContainer(btn: HTMLElement, actionRow: HTMLElement | null, viaGeometryFallback = false): HTMLElement | null {
  // A modal confirmation dialog (Messenger/Marketplace "Delete chat", ...) renders
  // a two-button Cancel/Confirm row the geometry fallback can mistake for a post
  // action row. The dialog holds no post, so the container search must NOT climb
  // out of it and borrow a permalink from the page behind the modal - exactly
  // what once mounted the picker between the dialog's buttons.
  const modal = closestModal(btn);
  const within = (el: HTMLElement | null): el is HTMLElement => !!el && (!modal || modal === el || modal.contains(el));

  const viewerContainer = resolveViewerContainer(btn, modal, within);
  if (viewerContainer) return viewerContainer;

  const standard = closestAny(btn, POST_CONTAINER_SELECTORS);
  if (within(standard)) return standard;
  // Ancestor walks below can climb OUT of page chrome and borrow a post link /
  // story container from the feed rendered beside it - verified live twice: the
  // UA profile header's CTA row ("Стежити") walked 12 levels up to a node
  // containing the whole feed and keyed itself on the first post; and the UA
  // own-profile composer row ("Ефір / Світлина/відео") passed the geometry test,
  // then findLocalStoryContainer escaped the composer block up to the section
  // holding the timeline's single post and stole that post's target - mounting
  // the trigger INSIDE the composer and deduping the real post row's picker
  // away. A label-matched action has proven a real Like/Comment row, so the
  // walks are safe there; a geometry-fallback match has NOT - it must sit in a
  // standard post container (language-independent markup), or it is page chrome.
  if (viaGeometryFallback) return null;
  const local = findLocalStoryContainer(actionRow ?? btn);
  if (within(local)) return local;
  for (const node of ancestors(btn, POST_CONTAINER_WALK_DEPTH)) {
    if (queryFirst(node, POST_LINK_SELECTORS)) return node;
    if (node === modal) return null;
  }
  return null;
}

// Standalone photo (`/photo/?fbid=`) and Reel (`/reel/<id>`) viewer pages render
// the action row outside any `[role="article"]` and ship no post permalink, so
// the feed-path link walk in findPostContainer can't resolve them. Use the
// standard container when the button sits inside one, else the enclosing modal,
// else the page body; extractTarget keys these from the page URL / player id.
// Returns null off those pages so the feed-path walk applies.
function resolveViewerContainer(btn: HTMLElement, modal: HTMLElement | null, within: (el: HTMLElement | null) => el is HTMLElement): HTMLElement | null {
  if (!isStandalonePhotoViewerPage() && !isStandaloneReelViewerPage()) return null;
  const standard = closestAny(btn, POST_CONTAINER_SELECTORS);
  if (within(standard)) return standard;
  return modal ?? document.body;
}

// A post opened inside a dialog (photo viewer, permalink modal) keeps its
// permalink within the dialog, so containment still resolves it; a bare
// confirmation dialog has none and is correctly left untouched.
function closestModal(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>(MODAL_SELECTOR);
}

// See the shared-photo collision handler in resolveTarget.
function hasOpenDialog(): boolean {
  return !!document.querySelector(MODAL_SELECTOR);
}

export default facebookAdapter;
