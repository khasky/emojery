// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryAll } from "../shared/dom-query";
import { type ActionKind, defineLabelRegistry, STEM, STEM_PARTS, stem } from "./action-labels";
import { rejectCommentRow } from "./action-row";
import { type Binding, defineSiteAdapter, type ScanContext } from "./framework";
import { urlChangeRescan } from "./observer-plugins";
import { ancestors, collapseWhitespace, compactElements, orderModalFirst, textOf } from "./runtime";
import { parseSiteHref } from "./url-target";
import { findVisualActionSlot, hasRenderableBox, isStructuralRoot, pageHasLayout } from "./visual-action-row";

const LIKE_ICON_SELECTORS = ['svg[aria-label="Like"]', 'svg[aria-label="Unlike"]', 'svg[role="img"][aria-label]'];
const POST_LINK_SELECTORS = ['a[href*="/p/"]', 'a[href*="/reel/"]', 'a[href*="/tv/"]'];

// `reels` (plural) is the immersive reel-viewer URL (`/reels/<sc>/`), `reel`
// (singular) the permalink - the SAME reel is reachable under both, so accept
// either and normalize to the canonical singular `/reel/<sc>/`, keeping one
// target key across both surfaces. `/reels/audio/<id>/` is the audio page, not a
// reel - its "shortcode" would be the literal "audio"; rejected in parseInstagramUrl.
const TARGET_PATH_RE = /^\/(?:(?:[A-Za-z0-9._]+)\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)(?:\/|$)/;
const ROW_WALK_DEPTH = 10;
// Post-action markers beyond Like - a post action bar carries at least one.
// `comment` is in SIBLING_KINDS on purpose: it is a genuine post action. Comment
// rows are rejected by isCommentRow's Reply check, never by this set.
const SIBLING_KINDS = new Set<ActionKind>(["comment", "share", "send", "repost"]);
// Menu labels on a comment's hover kebab ("Comment Options", "More options" and
// their localized forms) match the Comment stem; a menu is never a post action,
// so reject these labels outright. See isCommentRow. Cyrillic atoms carry no
// `\b`: JS word boundaries are ASCII-only, so `\bопци` can never match "Опции".
export const COMMENT_MENU_STEM = /\boption|\bmore\b|\bmenu\b|\bsettings\b|\bmanage\b|параметр|настройк|опци|опці|налаштув|дополнит|додатков/iu;

// Instagram localizes its action aria-labels, so the ICON carries the meaning the
// word can't: the registry tries exact -> data-icon -> icon path -> stems, and the
// paths below hold in every shipped UI locale. The stems stay the fallback for a
// layout that ships no path, and cover EN/RU/UA only - Like and Share omit the
// German part, Repost keeps just repost/репост/поширит. Reply is the exception,
// keeping the FULL shared stem: it is only ever used to REJECT a comment row (see
// isCommentRow), and recognizing «Antwort» is what keeps the picker off a comment
// on a German UI. IG reads each control's OWN aria-label (or visible text for an
// unlabeled Reply) and never a count summary, which the registry options encode.
export const IG_STEMS = {
  like: stem(STEM_PARTS.like.en, STEM_PARTS.like.ru, STEM_PARTS.like.ua),
  comment: STEM.comment,
  share: stem(STEM_PARTS.share.en, STEM_PARTS.share.ru, STEM_PARTS.share.ua),
  send: STEM.send,
  repost: stem(STEM_PARTS.repost.repost, STEM_PARTS.repost.repostRu, STEM_PARTS.repost.poshyryt),
  reply: STEM.reply,
} as const;

// Icon paths captured live on /p/ and the feed, identical across locales; the
// viewBox is NOT (the same repost glyph ships 22x22 and 24x24), so match the path
// and never the box. Like carries 2 variants because the glyph doubles as the
// liked-state read below: outline heart idle, filled heart liked.
// Share/Send is deliberately unregistered - Instagram serves the paper plane with
// a byte-identical `d` for the post's Share and the nav's Messages, and `comment`
// alone already proves a post row for SIBLING_KINDS.
const IDLE_LIKE_ICON_PATH_PREFIX = "M16.792 3.904";
const LIKED_ICON_PATH_PREFIX = "M34.6 3.1c-4.5";
const LIKE_ICON_PATH_PREFIXES = [IDLE_LIKE_ICON_PATH_PREFIX, LIKED_ICON_PATH_PREFIX];
const COMMENT_ICON_PATH_PREFIX = "M20.656 17.008";
const REPOST_ICON_PATH_PREFIX = "M19.998 9.497";
// Pinned against the live post by the e2e suite: a glyph redesign would strand
// every locale the EN/RU/UA stems don't cover, silently. Only the pair a
// LOGGED-OUT post renders is checkable there - the liked heart needs a session
// and Repost needs the feed, so those 2 ride on the site-auth suite instead.
export const IG_PUBLIC_ACTION_ICON_PATH_PREFIXES = [IDLE_LIKE_ICON_PATH_PREFIX, COMMENT_ICON_PATH_PREFIX];

// Liked-state read for auto-press. IG ships EN/RU/UA; the unlike aria starts
// with a negation ("Unlike", «Не нравится», «Не подобається») which the like
// stem alone cannot separate - the RU unlike CONTAINS «нравится».
export const IG_UNLIKE_RE = /^(unlike|не\s)/i;

// An unreadable/foreign label reads UNKNOWN (null) - see the likePressed
// contract in shared/adapter.ts.
export function igLikeLabelPressed(label: string): boolean | null {
  if (!label) return null;
  if (IG_UNLIKE_RE.test(label)) return true;
  if (IG_STEMS.like.test(label)) return false;
  return null;
}

// The same read, language-independent: Instagram swaps the outline heart for the
// filled one when the post is liked. Unknown path reads UNKNOWN (null) so the
// localized label below still gets its turn.
export function igLikeIconPressed(pathData: string): boolean | null {
  if (pathData.startsWith(LIKED_ICON_PATH_PREFIX)) return true;
  if (pathData.startsWith(IDLE_LIKE_ICON_PATH_PREFIX)) return false;
  return null;
}

function igLikePressed(likeButton: HTMLElement): boolean | null {
  const icon = likeButton.querySelector("svg[aria-label]");
  const byIcon = igLikeIconPressed(collapseWhitespace(icon?.querySelector("path[d]")?.getAttribute("d") ?? ""));
  if (byIcon !== null) return byIcon;
  return igLikeLabelPressed(icon?.getAttribute("aria-label")?.trim() ?? "");
}

const igLabels = defineLabelRegistry(
  {
    like: { iconPathPrefix: LIKE_ICON_PATH_PREFIXES, stems: IG_STEMS.like },
    comment: { iconPathPrefix: COMMENT_ICON_PATH_PREFIX, stems: IG_STEMS.comment },
    share: { stems: IG_STEMS.share },
    send: { stems: IG_STEMS.send },
    repost: { iconPathPrefix: REPOST_ICON_PATH_PREFIX, stems: IG_STEMS.repost },
    reply: { stems: IG_STEMS.reply },
  },
  {
    reject: COMMENT_MENU_STEM,
    rejectCountSummary: false,
    useTextFallback: true,
    readDescendantSvgLabels: false,
    controlSelector: '[role="button"]',
  },
);
// `comment` is deliberately absent from isCommentRow's marker list below (unlike
// SIBLING_KINDS above): the per-comment hover kebab carries the LOCALIZED word
// "comment" (EN "Comment options", RU «Действия с комментарием», UA «Параметри
// коментаря» - verified live), so counting it made a hovered comment row read as
// a post action bar and the picker jumped onto the comment. COMMENT_MENU_STEM
// catches some kebabs by their menu word but not RU «действия» - exactly why
// this recurred per-locale. Reply-presence is the locale-robust discriminator: a
// post action bar NEVER carries Reply, a comment row ALWAYS does.
const isCommentRow = rejectCommentRow(["share", "send", "repost"], "reply");
// A bare like/comment counter. Locales group thousands with a comma, dot,
// apostrophe, or space (uk/ru render "11 490"); textOf() has already collapsed
// NBSP/narrow-NBSP to a plain space, so allow it as a separator - without it a
// large count fails to match and the picker splits the Like icon from its count.
// `\p{Nd}` (not `\d`) so native-digit locales (bn, hi variants) still read as counts.
const COUNTER_DIGITS_RE = /^\p{Nd}[\p{Nd},.’' ]*$/u;
const LIKE_COUNTER_RE = /^\d[\d,.]*(?:\s?[KMB])?\s+likes?$/i;
// How long a standalone counter's like-word tail may be - room for the longest
// shipped form («отметки "Нравится"»); longer text is a caption.
const LIKE_TAIL_MAX = 24;

// The magnitude suffix is localized too: EN "1.2K", ru «41 тыс.», de «1,2 Mio.»,
// ja「1.2万」. An unmatched suffix left the reels-feed like count visible beside
// the trigger while replace-native had already hidden its heart button. Rather
// than hand-maintaining a per-language table, generate the suffix set for every
// shipped locale from the browser's own CLDR data (Intl compact notation) -
// magnitudes 1e3..1e12 cover each locale's full tier set. Longest-first so
// "Mrd." strips before "M"; dotted forms also add their dot-less variant.
// The unit suite pins this list against the shipped public/_locales folders.
export const COUNTER_LOCALES = ["bn", "da", "de", "en", "es", "et", "fi", "fr", "hi", "hu", "it", "ja", "ko", "lt", "ms", "nb", "nl", "pl", "pt-BR", "ru", "sv", "th", "uk", "vi", "zh-CN", "zh-TW"] as const;

function buildCompactCountSuffixes(): string[] {
  const suffixes = new Set<string>();
  for (const locale of COUNTER_LOCALES) {
    let format: Intl.NumberFormat;
    try {
      format = new Intl.NumberFormat(locale, { notation: "compact", compactDisplay: "short" });
    } catch {
      continue;
    }
    for (let magnitude = 1_000; magnitude <= 1_000_000_000_000; magnitude *= 10) {
      for (const part of format.formatToParts(magnitude)) {
        if (part.type !== "compact" || !part.value) continue;
        const token = part.value.toLowerCase();
        suffixes.add(token);
        if (token.endsWith(".")) suffixes.add(token.slice(0, -1));
      }
    }
  }
  return [...suffixes].sort((a, b) => b.length - a.length);
}

// Built on first use, not at module load: it constructs one Intl.NumberFormat per
// shipped locale and calls formatToParts across a magnitude ladder for each, which is
// tens of milliseconds of main-thread work - and as a module-level const every
// instagram.com page load paid it at document_start. The plain-digit fast path below
// answers most counters without ever needing the table.
let compactCountSuffixes: string[] | null = null;
function compactCountSuffixList(): string[] {
  compactCountSuffixes ??= buildCompactCountSuffixes();
  return compactCountSuffixes;
}

// "11 490" / "1.2K" / «41 тыс.» / «1,2 Mio.» /「1.2万」- a bare count in any
// shipped locale's short compact notation.
export function isBareCountText(raw: string): boolean {
  const text = raw.trim();
  if (COUNTER_DIGITS_RE.test(text)) return true;
  const lower = text.toLowerCase();
  for (const suffix of compactCountSuffixList()) {
    if (!lower.endsWith(suffix)) continue;
    const head = text.slice(0, text.length - suffix.length).trim();
    if (head && COUNTER_DIGITS_RE.test(head)) return true;
  }
  return false;
}

// The standalone like-count line under a post: EN "1,234 likes" (exact legacy
// form - the like STEM's \b never matches "likes"), or a bare count followed by
// a SHORT like-word tail in a locale whose Like stem we ship
// («2 534 отметки "Нравится"», UA «2 534 вподобання»). The tail-length cap and
// full anchoring keep captions that merely mention numbers and liking out.
export function isStandaloneLikeCountText(raw: string): boolean {
  const text = raw.trim();
  if (LIKE_COUNTER_RE.test(text)) return true;
  const words = text.split(" ");
  for (let split = 1; split < words.length && split <= 3; split++) {
    const tail = words.slice(split).join(" ");
    if (tail.length > LIKE_TAIL_MAX) continue;
    if (!IG_STEMS.like.test(tail)) continue;
    if (isBareCountText(words.slice(0, split).join(" "))) return true;
  }
  return false;
}

const instagramAdapter = defineSiteAdapter({
  site: "instagram",
  findCandidates: ({ root }) => {
    const buttons: HTMLElement[] = [];
    for (const icon of queryAll<SVGElement>(root, LIKE_ICON_SELECTORS)) {
      const button = icon.closest<HTMLElement>('[role="button"]');
      if (button) buttons.push(button);
    }
    // Opening a reel FROM THE FEED keeps the whole feed in the DOM (laid out,
    // behind the viewer overlay) - including the very post the viewer shows.
    // In document order that feed post claims the shared shortcode target first
    // and the viewer's rail is deduped away, so the open reel never got its
    // trigger (verified live). The rail lives outside any <article> while feed
    // posts are inside one, so on a reel page try non-article candidates first -
    // the mounted feed host then follows its target into the rail.
    const ordered = isOnReelViewerPage() ? [...buttons.filter((b) => !b.closest("article")), ...buttons.filter((b) => b.closest("article"))] : buttons;
    return orderModalFirst(ordered);
  },
  dedupeContainer: (likeButton, ctx) => actionRowFor(likeButton, ctx)?.row ?? null,
  resolveTarget: (likeButton, ctx) => {
    const actionRow = actionRowFor(likeButton, ctx);
    if (!actionRow) return null;
    const container = findPostContainer(actionRow.row);
    return extractTarget(container ?? actionRow.row);
  },
  resolveBinding: (likeButton, ctx) => {
    const actionRow = actionRowFor(likeButton, ctx);
    if (!actionRow) return null;
    const container = findPostContainer(actionRow.row);
    const inlineCount = findInlineLikeCount(actionRow.row, actionRow.likeSlot);
    const detachedCount = inlineCount ?? findStandaloneLikeCount(actionRow.row, container);
    // The like count's position relative to the Like icon is unstable - inline
    // inside the Like slot on some posts, a separate sibling on others, and it
    // can hydrate AFTER the scan - so anchoring relative to the count made it
    // "swap sides" of the picker between posts. Anchor BEFORE the next action
    // slot (Comment) instead - a stable boundary that keeps the whole Like+count
    // group on one side regardless of how/when the count renders. Fall back to
    // the count/Like-slot anchor only when there's no following action slot.
    const nextActionSlot = findNextActionSlot(actionRow.row, actionRow.likeSlot);
    const nativeElement = compactElements(actionRow.likeButton, detachedCount);
    const replaceElement = compactElements(actionRow.likeSlot, detachedCount);

    const binding: Binding = nextActionSlot ? { anchor: nextActionSlot, position: "before" } : { anchor: inlineCount ?? actionRow.likeSlot, position: "after" };
    if (nativeElement.length > 0) {
      binding.nativeElement = nativeElement.length === 1 ? nativeElement[0]! : nativeElement;
    }
    if (replaceElement.length > 0) {
      binding.replaceElement = replaceElement.length === 1 ? replaceElement[0]! : replaceElement;
    }
    binding.nativeVote = { like: actionRow.likeButton, likePressed: () => igLikePressed(actionRow.likeButton) };
    if (actionRow.rail) binding.triggerLayout = "icon-column";
    return binding;
  },
  observer: {
    attributeFilter: ["aria-label", "href"],
    navKey: "pathname",
    linkPrimeSelectors: () => POST_LINK_SELECTORS,
    // Instagram is a pushState SPA: opening a post, returning to the feed, and
    // advancing the reel viewer all change the URL without a popstate, and the
    // new surface can settle without a childList mutation - the picker went
    // missing after such navigations. Re-scan on every pathname change at a few
    // settle delays. Not gated to reels: the same miss happens on post/feed nav.
    plugins: [urlChangeRescan()],
  },
});

interface ActionRow {
  row: HTMLElement;
  likeSlot: HTMLElement;
  likeButton: HTMLElement;
  /** Set when the "row" is a reel viewer's VERTICAL action rail - the binding
   *  then opts the trigger into the round icon-column form. */
  rail?: boolean;
}

function actionRowFor(likeButton: HTMLElement, ctx: ScanContext): ActionRow | null {
  return ctx.memo(likeButton, () => findActionRow(likeButton));
}

function findActionRow(likeButton: HTMLElement): ActionRow | null {
  const candidate = findActionRowCandidate(likeButton);
  // Reject a row that POSITIVELY reads as a comment row: on the /p/ detail page
  // every comment carries its own Like heart, so the locale-independent visual
  // scan could latch one and the picker floated from comment to comment on
  // scroll. See isCommentRow for why the rejection keys on Reply.
  if (candidate && looksLikeCommentRow(candidate.row)) return null;
  return candidate;
}

function findActionRowCandidate(likeButton: HTMLElement): ActionRow | null {
  // Reel viewer first: an immersive reel (`/reel(s)/<sc>/`) stacks its actions
  // as a VERTICAL rail (Like / Comment / Share / Save ...) - the opposite of the
  // horizontal post bar the geometry/structural paths below look for, so they
  // reject it and no picker mounts. Detect the rail directly when we're on a
  // reel page. (Mirrors the Facebook/YouTube reel handling.)
  const reel = findReelRail(likeButton);
  if (reel) return reel;

  // Stays available on a reel viewer page: a /reel/<sc>/ permalink can render the
  // POST-style detail layout (video + comments pane), whose actions are a
  // horizontal bar, not a rail - rejecting it left the reel with a stale
  // pre-hydration mount. The tight geometry gates can't match a reel feed's whole
  // container, so the off-screen-neighbour problem below doesn't apply here.
  const visual = findVisualActionSlot(likeButton, {
    maxDepth: ROW_WALK_DEPTH,
    minSlots: 3,
    maxSlots: 5,
    minRowWidth: 60,
    maxRowHeight: 96,
    minSlotWidth: 16,
    minSlotHeight: 16,
    controlSelector: '[role="button"]',
    controlPredicate: isIconActionControl,
    boundary: isActionSearchBoundary,
  });
  if (visual && visual.index === 0) {
    return { row: visual.row, likeSlot: visual.slot, likeButton };
  }

  // The STRUCTURAL fallback below must not run on a reel viewer: the feed keeps
  // several reels in the DOM sharing the one URL-derived target, and the
  // height-uncapped fallback would latch an off-screen reel container as the
  // "row", claim that target first, and dedupe out the real active rail.
  if (isOnReelViewerPage()) return null;

  return findStructuralActionRow(likeButton);
}

// Structural fallback for a post exposing only TWO actions - a video post with
// sharing/reposting disabled renders just Like + Comment (verified live on /p/) -
// which the visual scan's >=3-slot gate rejects. Signature: a Like with a
// Comment/Share/Send/Repost sibling (a comment-reply row pairs Like with a text
// "Reply" only). On a laid-out page the row must also read horizontal so a Reels
// rail can't match; headless/pre-paint scans have no geometry and skip that guard.
function findStructuralActionRow(likeButton: HTMLElement): ActionRow | null {
  if (!containsLikeAction(likeButton)) return null;
  const laidOut = pageHasLayout();

  let node: HTMLElement | null = likeButton;
  for (let depth = 0; depth < ROW_WALK_DEPTH && node; depth++) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent || isActionSearchBoundary(parent)) return null;
    if (hasSiblingActionMarker(parent, node) && containsLikeAction(parent) && (!laidOut || isHorizontalRow(parent))) {
      return { row: parent, likeSlot: node, likeButton };
    }
    node = parent;
  }
  return null;
}

// See rejectCommentRow: positive recognition only.
function looksLikeCommentRow(row: HTMLElement): boolean {
  return isCommentRow(row, igLabels);
}

// On a reel viewer the actions sit in a VERTICAL rail (Like / Comment / Share /
// Save / ...). Walk up from the Like to the first vertical ancestor carrying the
// Like plus another action marker and treat it as the "row". The viewer keeps
// several reels in the DOM but only the active one is in the viewport and is
// what the URL points at - gate to it so the single location-derived target
// lands on the visible reel, not an off-screen neighbour. The `rail` flag opts
// the trigger into the round icon-column form.
function findReelRail(likeButton: HTMLElement): ActionRow | null {
  if (!isOnReelViewerPage()) return null;
  let node: HTMLElement = likeButton;
  for (let depth = 0; depth < ROW_WALK_DEPTH; depth++) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent || isActionSearchBoundary(parent)) return null;
    if (isVerticalRail(parent) && hasSiblingActionMarker(parent, node) && containsLikeAction(parent)) {
      // `node` is now the rail's direct child holding the Like (the like slot).
      return isActiveReelRail(parent) ? { row: parent, likeSlot: node, likeButton, rail: true } : null;
    }
    node = parent;
  }
  return null;
}

// We're on a single reel's page (immersive viewer or permalink), i.e. the path
// is `/reel(s)/<shortcode>/` - not the reels home, a profile reels tab, or audio.
function isOnReelViewerPage(): boolean {
  return /^\/reels?\//.test(location.pathname) && currentPagePostUrl() !== null;
}

// A vertical action rail is a NARROW column of icon buttons: taller than it is
// wide, tall enough not to be a stray two-icon stack, and no wider than an icon
// slot (~60px measured live; 120 leaves zoom/font headroom). The width cap is
// load-bearing: a /reel/<sc>/ permalink or modal can render the POST-detail
// layout, whose ~500px comments pane also reads taller-than-wide and carries
// like hearts + action markers - without the cap the rail walk latched it and
// the picker mounted above the first comment instead of beside the Like.
const RAIL_MAX_WIDTH = 120;
const RAIL_MIN_HEIGHT = 120;
function isVerticalRail(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.height > rect.width && rect.height >= RAIL_MIN_HEIGHT && rect.width <= RAIL_MAX_WIDTH;
}

// The active reel's rail is the one in the viewport; the feed's off-screen
// neighbours are skipped so the location-derived target only mounts on the reel
// the URL actually points at. Pre-paint scans (no geometry) can't gate, so allow.
// The rail counts as active when it overlaps the middle band of the viewport:
// top above 70% of the height, bottom below 30%.
const ACTIVE_RAIL_TOP_MAX_VH = 0.7;
const ACTIVE_RAIL_BOTTOM_MIN_VH = 0.3;
function isActiveReelRail(el: HTMLElement): boolean {
  if (!pageHasLayout()) return true;
  const rect = el.getBoundingClientRect();
  const vh = window.innerHeight || document.documentElement.clientHeight;
  return rect.top < vh * ACTIVE_RAIL_TOP_MAX_VH && rect.bottom > vh * ACTIVE_RAIL_BOTTOM_MIN_VH;
}

// A post action row is a horizontal strip - its icons sit side by side, so it
// is at least as wide as it is tall. Used to keep the structural fallback from
// latching onto a vertical icon stack (e.g. a Reels action rail) on a laid-out
// page, where the visual scan's geometry filters don't run.
function isHorizontalRow(row: HTMLElement): boolean {
  const rect = row.getBoundingClientRect();
  return rect.width >= rect.height;
}

function isActionSearchBoundary(el: HTMLElement): boolean {
  return isStructuralRoot(el) || el.tagName === "ARTICLE";
}

function isIconActionControl(el: HTMLElement): boolean {
  return el.matches('[role="button"]') && !!el.querySelector("svg");
}

// Counters are role=button too but carry no svg, so this separates "next action slot" from
// "this action's count" regardless of locale.
function containsIconActionControl(root: Element): boolean {
  if (root instanceof HTMLElement && isIconActionControl(root)) return true;
  for (const button of Array.from(root.querySelectorAll<HTMLElement>('[role="button"]'))) {
    if (button.querySelector("svg")) return true;
  }
  return false;
}

function hasSiblingActionMarker(parent: HTMLElement, branch: HTMLElement): boolean {
  for (const child of Array.from(parent.children)) {
    if (child === branch) continue;
    if (containsSiblingMarker(child)) return true;
  }
  return false;
}

// Instagram puts the label on either the role=button or its child svg, so the
// root and every descendant `[aria-label]` is classified by its OWN label.
function containsSiblingMarker(root: Element): boolean {
  return actionLabelElements(root).some((el) => {
    const kind = igLabels.classify(el);
    return kind != null && SIBLING_KINDS.has(kind);
  });
}

function containsLikeAction(root: Element): boolean {
  return actionLabelElements(root).some((el) => igLabels.classify(el) === "like");
}

function actionLabelElements(root: Element): Element[] {
  const out: Element[] = [];
  if (root.hasAttribute("aria-label")) out.push(root);
  out.push(...Array.from(root.querySelectorAll("[aria-label]")));
  return out;
}

// Following element siblings, at most `maxCount` of them. Every bounded
// strip-walk in this adapter goes through here; the budget counts siblings
// VISITED, not siblings accepted, so each caller keeps its own narrowing and
// early-exit rules.
function* siblingsAfter(el: Element, maxCount: number): Generator<Element> {
  let sibling = el.nextElementSibling;
  for (let i = 0; i < maxCount && sibling; i++) {
    yield sibling;
    sibling = sibling.nextElementSibling;
  }
}

// How many siblings past the Like slot may separate it from the next action -
// count wrappers and spacer divs, never a whole row.
const NEXT_ACTION_WALK_DEPTH = 6;

// The next icon-action slot (Comment/Share/...) after the Like slot in the row -
// the picker's stable anchor (see resolveBinding for why the count isn't one).
function findNextActionSlot(row: HTMLElement, likeSlot: HTMLElement): HTMLElement | null {
  for (const sibling of siblingsAfter(likeSlot, NEXT_ACTION_WALK_DEPTH)) {
    if (sibling instanceof HTMLElement && containsIconActionControl(sibling) && row.contains(sibling)) {
      return sibling;
    }
  }
  return null;
}

// Siblings after the Like slot that may hold its inline count; the next-action
// check below stops the search earlier on a normal row.
const INLINE_COUNT_WALK_DEPTH = 5;

function findInlineLikeCount(row: HTMLElement, likeSlot: HTMLElement): HTMLElement | null {
  for (const sibling of siblingsAfter(likeSlot, INLINE_COUNT_WALK_DEPTH)) {
    const el = sibling as HTMLElement;
    // Stop at the next action slot (Comment/Share/...) so the search never spills
    // into a following icon's counter. Detect the slot structurally (icon-action
    // control) - Instagram localizes the aria-labels, so a marker check would
    // miss "Коментувати" and walk past Comment into its count.
    if (containsIconActionControl(el)) return null;
    const counter = findCounterElement(el, isBareCountText);
    if (counter && row.contains(counter)) return counter;
  }
  return null;
}

// The standalone like-count line sits below the action row, at most a couple of
// wrapper levels above it - stay shallow so the search can't escape the post.
const STANDALONE_COUNT_WALK_DEPTH = 3;

function findStandaloneLikeCount(row: HTMLElement, container: HTMLElement | null): HTMLElement | null {
  for (const node of ancestors(row, STANDALONE_COUNT_WALK_DEPTH)) {
    const counter = findLikeCountAfter(node, container);
    if (counter) return counter;
  }
  return null;
}

// Siblings after the row/wrapper to scan for the count line - enough to clear
// the carousel dots and a spacer, short of the caption block.
const LIKE_COUNT_SIBLING_WALK_DEPTH = 4;

function findLikeCountAfter(anchor: HTMLElement, container: HTMLElement | null): HTMLElement | null {
  for (const sibling of siblingsAfter(anchor, LIKE_COUNT_SIBLING_WALK_DEPTH)) {
    if (container && !container.contains(sibling)) return null;
    const counter = findCounterElement(sibling as HTMLElement, isStandaloneLikeCountText);
    if (counter) return counter;
  }
  return null;
}

function findCounterElement(root: HTMLElement, predicate: (text: string) => boolean): HTMLElement | null {
  if (!root.querySelector("svg") && isUsableCounter(root) && predicate(textOf(root))) {
    return root;
  }
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('[role="button"], span, a, div'))) {
    if (el.querySelector("svg")) continue;
    if (!isUsableCounter(el)) continue;
    if (predicate(textOf(el))) return el;
  }
  return null;
}

function isUsableCounter(el: HTMLElement): boolean {
  if (!pageHasLayout()) return true;
  if (!hasRenderableBox(el)) return false;
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

function findPostContainer(el: HTMLElement): HTMLElement | null {
  return el.closest<HTMLElement>("article");
}

function extractTarget(container: HTMLElement): TargetRef | null {
  const permalink = findPermalink(container) ?? currentPagePostUrl();
  if (!permalink) return null;
  const parsed = parseInstagramUrl(permalink);
  if (!parsed) return null;
  return instagramTargetFromRef(parsed);
}

export function instagramTargetFromRef(ref: { shortcode: string; url: string }): TargetRef {
  return { site: "instagram", targetId: ref.shortcode, url: ref.url };
}

function findPermalink(root: ParentNode): string | null {
  for (const link of queryAll<HTMLAnchorElement>(root, POST_LINK_SELECTORS)) {
    const parsed = parseInstagramUrl(link.getAttribute("href") || link.href);
    if (parsed) return parsed.url;
  }
  return null;
}

function currentPagePostUrl(): string | null {
  return parseInstagramUrl(location.href)?.url ?? null;
}

// Carries the canonical `url` alongside the parsed parts: `target-contract.ts`
// pairs it with `instagramTargetFromRef`, so the canonical URL has ONE
// construction site (parseInstagramUrl) rather than a second copy per caller.
export function extractInstagramShortcode(href: string): { kind: string; shortcode: string; url: string } | null {
  return parseInstagramUrl(href);
}

function parseInstagramUrl(href: string): { kind: string; shortcode: string; url: string } | null {
  return parseSiteHref(href, "instagram", (url) => {
    const match = url.pathname.match(TARGET_PATH_RE);
    const kindRaw = match?.[1];
    const shortcode = match?.[2];
    if (!kindRaw || !shortcode) return null;
    // `/reels/audio/<id>/` is the audio page, not a reel permalink.
    if (kindRaw === "reels" && shortcode === "audio") return null;
    // Canonical singular form so `/reels/<sc>/` and `/reel/<sc>/` converge.
    const kind = kindRaw === "reels" ? "reel" : kindRaw;
    return {
      kind,
      shortcode,
      url: `https://www.instagram.com/${kind}/${shortcode}/`,
    };
  });
}

export default instagramAdapter;
