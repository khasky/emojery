// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryAll } from "../shared/dom-query";
import { defineLabelRegistry } from "./action-labels";
import { isPaintedFill } from "./css-alpha";
import { type Binding, defineSiteAdapter, type ScanContext } from "./framework";
import { urlChangeRescan } from "./observer-plugins";
import { ancestors, directChildSlot, precedes } from "./runtime";
import { parseSiteHref } from "./url-target";
import { findVisualActionSlot, isStructuralRoot, pageHasLayout } from "./visual-action-row";

// One generic selector on purpose: Like/Liked/Unlike variants are strict
// subsets of it, and queryAll dedupes, so listing them added nothing.
// closestActionButton + the label registry do the actual classification.
const LIKE_ICON_SELECTORS = ['svg[role="img"][aria-label]'];
const REPLY_ICON_SELECTORS = ['svg[aria-label="Reply"][role="img"]', 'svg[aria-label="Comment"][role="img"]'];
const POST_LINK_SELECTORS = ['a[href*="/post/"]'];

const POST_PATH_RE = /^\/@([A-Za-z0-9._]+)\/post\/([A-Za-z0-9_-]+)(?:\/|$)/;

// The photo lightbox is a URL-addressed OVERLAY: opening a photo pushes
// `/@user/post/<id>/media` over a page whose DOM stays as it was, and that id
// is the photo OWNER's - on a reply's page, the parent post's. Scanning there
// mounted the parent's (invisible) trigger behind the lightbox and the close
// then had to tear it down again - a visible blink of a trigger the page must
// not carry (and, when the teardown scan lost the race, a stale trigger taking
// votes for the wrong post). Nothing the lightbox shows has an action row, so
// the whole scan is suspended for its URL.
export function isMediaViewerPath(pathname: string): boolean {
  return /^\/@[A-Za-z0-9._]+\/post\/[A-Za-z0-9_-]+\/media(?:\/|$)/.test(pathname);
}
const BUTTON_WALK_DEPTH = 6;
const ROW_WALK_DEPTH = 10;
const TARGET_WALK_DEPTH = 12;

const threadsAdapter = defineSiteAdapter({
  site: "threads",
  findCandidates: ({ root }) => {
    const buttons: HTMLElement[] = [];
    for (const icon of queryAll<SVGElement>(root, LIKE_ICON_SELECTORS)) {
      const button = closestActionButton(icon);
      if (button && !buttons.includes(button)) buttons.push(button);
    }
    return dropFeedReplyButtons(dropNestedQuotedButtons(buttons));
  },
  dedupeContainer: (likeButton, ctx) => actionRowFor(likeButton, ctx)?.row ?? null,
  resolveTarget: (likeButton, ctx) => {
    const actionRow = actionRowFor(likeButton, ctx);
    if (!actionRow) return null;
    const currentPost = parseThreadsPostUrl(location.href);
    const target = extractTarget(actionRow.row, currentPost);
    if (!target) return null;
    // On a rendered detail/reply page, only mount the post the URL points at -
    // reply rows resolve to their own (different) target and are dropped.
    const currentTargetId = currentPost ? currentPost.postId : null;
    if (currentTargetId && target.targetId !== currentTargetId) return null;
    return target;
  },
  resolveBinding: (likeButton, ctx) => {
    const actionRow = actionRowFor(likeButton, ctx);
    if (!actionRow) return null;
    // Anchor before the Reply (comment) control. With a Like present this lands
    // the picker between Like and Reply; when likes are disabled the row starts
    // at Reply, so the picker sits before the comment button - both correct.
    const binding: Binding = { anchor: actionRow.replySlot, position: "before" };
    if (actionRow.likeButton) {
      const rowLikeButton = actionRow.likeButton;
      binding.nativeElement = rowLikeButton;
      binding.replaceElement = rowLikeButton;
      binding.nativeVote = { like: rowLikeButton, likePressed: () => threadsLikePressed(rowLikeButton) };
    }
    return binding;
  },
  observer: {
    attributeFilter: ["aria-label", "href", "role", "tabindex"],
    navKey: "pathname",
    navAlwaysTrigger: true,
    // See isMediaViewerPath: the lightbox URL freezes the scan; the
    // urlChangeRescan plugin below fires the catch-up scans on close.
    suspendScan: () => isMediaViewerPath(location.pathname),
    linkPrimeSelectors: () => POST_LINK_SELECTORS,
    // Threads is a pushState SPA whose navigations can settle with NO further
    // mutations - closing the /media viewer pushes the reply's URL onto an
    // already-rendered page, so the mutation-driven observer never fired and the
    // route-change scan that drops the parent post's now-stale trigger ran only
    // when the user happened to scroll (verified live: the trigger survived 15s+
    // after the viewer closed). Poll-and-rescan on every pathname change, same
    // as Instagram.
    plugins: [urlChangeRescan()],
  },
});

interface ActionRow {
  row: HTMLElement;
  replySlot: HTMLElement;
  // Absent when the post has likes disabled (the row starts at Reply).
  likeButton?: HTMLElement;
}

function actionRowFor(likeButton: HTMLElement, ctx: ScanContext): ActionRow | null {
  return ctx.memo(likeButton, () => findActionRow(likeButton));
}

// Threads wraps every post - and every quoted/reposted post embedded inside
// another - in its own `data-pressable-container`. When post A quotes/reposts
// post B, B's card (with its own action row) is a pressable nested inside A's.
// The picker must mount only on the top-level post, never the embedded original.
//
// Drop a candidate whose pressable is strictly contained in another candidate's
// pressable - that marks it as an embedded quote. Fully locale-independent: it
// keys only on the pressable-container nesting of the candidate set, never on a
// Like label (which would fail on a localized UI).
function dropNestedQuotedButtons(buttons: HTMLElement[]): HTMLElement[] {
  const pressables = buttons.map((b) => b.closest<HTMLElement>("[data-pressable-container]"));
  const distinct = [...new Set(pressables.filter((p): p is HTMLElement => p !== null))];
  return buttons.filter((_button, i) => {
    const own = pressables[i];
    if (!own) return true; // no pressable info (headless / pre-paint) -> keep
    // Nested when another candidate's pressable strictly contains this one.
    return !distinct.some((other) => other !== own && other.contains(own));
  });
}

// A feed "thread" unit (home feed, profile, search) renders the main post plus
// its first replies as SIBLING pressables inside one feed unit container
// (`[data-pagelet="threads_feed_..."] > [data-virtualized]`), each reply with its
// own full action row. Siblings defeat dropNestedQuotedButtons (no nesting),
// and off a detail page resolveTarget has no page URL to reject them against -
// so without this filter every reply in the unit mounted its own picker.
// Keep only the unit's FIRST pressable (document order = the main post; a
// quote's nested pressable can never precede its containing top-level post).
// On a post detail page the resolveTarget URL check governs instead - and the
// unit there may legitimately start with the parent-context post above the
// focused reply, so this filter must not run (it would drop the focused post).
function dropFeedReplyButtons(buttons: HTMLElement[]): HTMLElement[] {
  if (parseThreadsPostUrl(location.href)) return buttons;
  return buttons.filter((button) => {
    const unit = button.closest<HTMLElement>("[data-virtualized], [data-pagelet]");
    if (!unit) return true; // no unit info (headless / other surface) -> keep
    const firstPressable = unit.querySelector<HTMLElement>("[data-pressable-container]");
    if (!firstPressable) return true;
    return button.closest<HTMLElement>("[data-pressable-container]") === firstPressable;
  });
}

// True when a `/post/` link belongs to the same post as `row` - its nearest
// pressable container also contains the action row. A quoted post's timestamp
// link lives in the quote's nested pressable, which does not contain the parent
// post's action row, so it is not that row's target. Falls back to true when
// there is no pressable info (headless / pre-paint).
function linkBelongsToRowPost(link: Element, row: HTMLElement): boolean {
  const pressable = link.closest<HTMLElement>("[data-pressable-container]");
  if (!pressable) return true;
  return pressable.contains(row);
}

function findActionRow(candidate: HTMLElement): ActionRow | null {
  const visual = findVisualActionSlot(candidate, {
    maxDepth: ROW_WALK_DEPTH,
    // A real Threads post action row always exposes at least Like, Comment and
    // Repost (Share too), so require >=3 icon slots. This rejects the post HEADER
    // cluster - the pencil (Edit) + "..." (More) pair sits in a 2-slot row, which
    // the locale-independent catch-all `svg[role="img"][aria-label]` scan would
    // otherwise treat as an action row, mounting a stray trigger in the
    // top-right of every post.
    minSlots: 3,
    maxSlots: 5,
    minRowWidth: 48,
    maxRowHeight: 96,
    minSlotWidth: 16,
    minSlotHeight: 16,
    controlPredicate: isActionButton,
    boundary: isSearchBoundary,
  });
  if (visual) {
    const built = buildActionRow(visual.row, visual.slots);
    if (built) return built;
  }

  // Headless / no-layout fallback (jsdom, document_idle before paint): identify
  // the row by English aria-labels. Localized live pages always reach the
  // visual path above (they have geometry), so this English-only path is only
  // exercised by tests and very early scans. It must also not run after a
  // rejected visual row: the catch-all candidate scan surfaces 3-icon clusters
  // that are NOT post action rows (header Follow/More group, profile chips) and
  // this walk could re-grab one.
  if (pageHasLayout()) return null;
  if (!containsKnownLikeIcon(candidate)) return null;

  let node: HTMLElement | null = candidate;
  for (let depth = 0; depth < ROW_WALK_DEPTH && node; depth++) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent || isSearchBoundary(parent)) return null;

    const replyButton = findReplyButton(parent, candidate);
    if (replyButton) {
      const likeSlot = directChildSlot(candidate, parent) ?? candidate;
      const replySlot = directChildSlot(replyButton, parent) ?? replyButton;
      if (likeSlot !== replySlot) {
        return { row: parent, replySlot, likeButton: candidate };
      }
    }

    node = parent;
  }
  return null;
}

// Build an action row from a visually-detected icon row, or null when it isn't
// a genuine Threads post action row. Invariant: a post action row always pairs
// the Reply (comment) control with another post action - Repost or Share -
// while headers and other icon clusters carry neither. Repost alone is NOT
// required: after the user reposts, Threads swaps the repost icon for an "undo"
// glyph. Both path variants sit in REPOST_ICON_PATH_PREFIXES today, but while
// only the idle one was registered, requiring Repost dropped the reposted
// post's picker on every surface - and any future unregistered variant would
// again. Share has no such state-dependent glyph, so either action proves the
// row. (Anchoring on the Reply slot is resolveBinding's story, above.)
function buildActionRow(row: HTMLElement, slots: HTMLElement[]): ActionRow | null {
  const replyIdx = slots.findIndex(isReplySlot);
  if (replyIdx < 0) return null;
  if (!slots.some(isRepostSlot) && !slots.some(isShareSlot)) return null;
  const actionRow: ActionRow = { row, replySlot: slots[replyIdx]! };
  const likeSlot = replyIdx > 0 ? slots[replyIdx - 1] : undefined;
  if (likeSlot) {
    const likeButton = actionButtonInSlot(likeSlot);
    if (likeButton) actionRow.likeButton = likeButton;
  }
  return actionRow;
}

// Liked-state read for auto-press, by the one signal that holds in every language:
// the heart is an OUTLINE when unliked and PAINTED when liked. The aria-label is
// localized - a RU feed reads «Поставить "Нравится"» / «Не нравится» - so matching
// the English strings returned null on every other locale, and an unknown state
// makes the trigger engine decline to press at all: auto-press was silently dead
// outside English. Captured live on a RU feed: unliked `fill: rgba(0, 0, 0, 0)`
// (`--x-fill: transparent`), liked `color(display-p3 1 0.18 0.25)`
// (`--x-fill: currentColor`). Reading the paint rather than the icon's path data
// also survives an icon redesign, unlike the path prefixes in the registry below.
function threadsLikePressed(likeButton: HTMLElement): boolean | null {
  const icon = likeButton.querySelector("svg[aria-label]");
  return icon ? isPaintedFill(getComputedStyle(icon).fill) : null;
}

// Re-exported, not re-implemented: the paint read lives in css-alpha.ts, shared with the
// Facebook filled-chip probe. It travels out through this module because the site-auth
// bridge serializes the pressed-state reader from here (e2e/site-auth/auto-press.test.ts
// takes both symbols off this adapter), so the export site is part of that contract.
export { isPaintedFill } from "./css-alpha";

function actionButtonInSlot(slot: HTMLElement): HTMLElement | undefined {
  if (isActionButton(slot)) return slot;
  for (const el of Array.from(slot.querySelectorAll<HTMLElement>('button,[role="button"]'))) {
    if (isActionButton(el)) return el;
  }
  return undefined;
}

// Threads localizes the icon aria-labels, so Reply/Repost/Share are matched
// locale-independently by the distinctive prefix of their SVG path data
// (captured live), with the English aria-label stems as a LAST resort (the
// registry tries exact -> data-icon -> icon path -> stems); Like by its exact aria.
// If Threads redesigns an icon these prefixes must be refreshed - the English
// labels keep unlocalized UIs working in the meantime. NOTE: the Share prefix
// must stay precise enough not to match the sidebar Messages icon, whose path
// starts "M7.24745 1.49856" (one more digit).
const REPLY_ICON_PATH_PREFIX = "M12 3C7.02944 3 3 7.02944 3 12";
// Two path variants: idle loop and the "you reposted" active glyph
// (captured live; aria-label stays «Сделать репост» in both states).
const REPOST_ICON_PATH_PREFIXES = ["M4.51617 6.9986", "M11.9996 3C8.88111"];
const SHARE_ICON_PATH_PREFIX = "M7.2474 1.49853";

// Every non-Like action icon - the site-auth suite finds the heart by
// excluding these, so it must stay in lockstep with the registry below.
export const THREADS_NON_LIKE_ICON_PATH_PREFIXES = [REPLY_ICON_PATH_PREFIX, ...REPOST_ICON_PATH_PREFIXES, SHARE_ICON_PATH_PREFIX];

const threadsLabels = defineLabelRegistry(
  {
    reply: {
      stems: /^(reply|comment)\b/i,
      iconPathPrefix: REPLY_ICON_PATH_PREFIX,
    },
    repost: { stems: /^(repost(ed)?|reshare)\b/i, iconPathPrefix: REPOST_ICON_PATH_PREFIXES },
    share: { stems: /^share\b/i, iconPathPrefix: SHARE_ICON_PATH_PREFIX },
    like: { exact: ["like", "liked", "unlike"] },
  },
  { useTextFallback: false },
);

function isReplySlot(slot: HTMLElement): boolean {
  return threadsLabels.matchAction(slot, "reply");
}

function isRepostSlot(slot: HTMLElement): boolean {
  return threadsLabels.matchAction(slot, "repost");
}

function isShareSlot(slot: HTMLElement): boolean {
  return threadsLabels.matchAction(slot, "share");
}

function containsKnownLikeIcon(root: Element): boolean {
  return Array.from(root.querySelectorAll<SVGElement>("svg[aria-label]")).some((icon) => threadsLabels.classify(icon) === "like");
}

function findReplyButton(root: ParentNode, likeButton: HTMLElement): HTMLElement | null {
  for (const icon of queryAll<SVGElement>(root, REPLY_ICON_SELECTORS)) {
    const button = closestActionButton(icon);
    if (!button || button === likeButton) continue;
    if (button.contains(likeButton) || likeButton.contains(button)) continue;
    return button;
  }
  return null;
}

function closestActionButton(icon: Element): HTMLElement | null {
  const start = icon.parentElement;
  if (!start) return null;
  for (const node of ancestors(start, BUTTON_WALK_DEPTH)) {
    if (isActionButton(node)) return node;
  }
  return null;
}

function isActionButton(el: HTMLElement): boolean {
  return el.tagName === "BUTTON" || el.getAttribute("role") === "button";
}

function isSearchBoundary(el: HTMLElement): boolean {
  return isStructuralRoot(el) || el.getAttribute("role") === "main";
}

function extractTarget(row: HTMLElement, currentPost: ThreadsPostRef | null): TargetRef | null {
  const parsed = findNearestPostRef(row);
  if (parsed) return threadsTargetFromRef(parsed);
  // No permalink in the DOM: fall back to the page URL only pre-paint - a laid-out
  // page with no /post/ link is a surface we must not key on.
  if (!currentPost || pageHasLayout()) return null;
  return threadsTargetFromRef(currentPost);
}

export function threadsTargetFromRef(parsed: ThreadsPostRef): TargetRef {
  return {
    site: "threads",
    targetId: parsed.postId,
    url: parsed.url,
  };
}

function findNearestPostRef(row: HTMLElement): ThreadsPostRef | null {
  let firstAny: ThreadsPostRef | null = null;
  for (const node of ancestors(row, TARGET_WALK_DEPTH)) {
    const { any, timed } = findPostRefBefore(node, row);
    // A canonical post permalink - the header timestamp link - wraps a <time>
    // element; a quoted/embedded post's author link does not. A quote (repost
    // with comment) renders the embedded original's card BETWEEN the author's
    // text and the action row, so the nearest /post/ link walking up from the
    // row is the ORIGINAL's, not this post's - and resolveTarget then drops the
    // mount on a detail page because that target != the page URL (verified live).
    // Prefer the nearest <time>-bearing permalink across the walk; fall back to
    // the nearest untimed link when none exists (unchanged for plain posts).
    if (timed) return timed;
    if (any && !firstAny) firstAny = any;
    if (isSearchBoundary(node)) break;
  }
  return firstAny;
}

function findPostRefBefore(root: ParentNode, row: HTMLElement): { any: ThreadsPostRef | null; timed: ThreadsPostRef | null } {
  let any: ThreadsPostRef | null = null;
  let timed: ThreadsPostRef | null = null;
  for (const link of queryAll<HTMLAnchorElement>(root, POST_LINK_SELECTORS)) {
    if (!link.contains(row) && !precedes(link, row)) continue;
    // Skip a permalink that lives inside a NESTED quoted post's pressable - it
    // belongs to the embedded original, not to this row's (top-level) post.
    if (!linkBelongsToRowPost(link, row)) continue;
    const parsed = parseThreadsPostUrl(link.getAttribute("href") || link.href);
    if (!parsed) continue;
    any = parsed;
    if (link.querySelector("time")) timed = parsed;
  }
  return { any, timed };
}

export function extractThreadsPostRef(href: string): ThreadsPostRef | null {
  return parseThreadsPostUrl(href);
}

interface ThreadsPostRef {
  handle: string;
  postId: string;
  url: string;
}

function parseThreadsPostUrl(href: string): ThreadsPostRef | null {
  return parseSiteHref(href, "threads", (url) => {
    const match = url.pathname.match(POST_PATH_RE);
    const handle = match?.[1];
    const postId = match?.[2];
    if (!handle || !postId) return null;
    return {
      handle,
      postId,
      url: `https://www.threads.com/@${handle}/post/${postId}`,
    };
  });
}

export default threadsAdapter;
