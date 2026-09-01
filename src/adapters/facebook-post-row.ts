// SPDX-License-Identifier: GPL-3.0-or-later
//
// Facebook: is this control a POST action row's Like, and which row is it in?
// Everything here answers that one question - the localized label registry, the
// language-blind geometry fallback, the rejections (comment rows, profile and
// page headers, the composer, admin tools, Messenger threads), and the two
// ancestor walks that bound a single post unit. It reads the DOM and returns
// verdicts; it never builds a target or a placement.
//
// Leaf module: it imports no other facebook module except the pure URL helpers.

import { OWN_NODES_SELECTOR } from "../shared/dom";
import { type ActionKind, defineLabelRegistry, isCountSummary, STEM, STEM_PARTS, stem } from "./action-labels";
import { rejectCommentRow } from "./action-row";
import { isPaintedFill } from "./css-alpha";
import { normalizeCftHref, normalizePhotoHref, normalizePostHref } from "./facebook-urls";
import { ancestors, collapseWhitespace, textOf } from "./runtime";
import { findVisualActionSlot, isRenderableInPageLayout, isStructuralRoot, type VisualActionSlot } from "./visual-action-row";

// A global `[role="button"]` sweep - every Like variant Facebook ships is one.
// The Like verdict itself lives in readPostActionLikeButton.
export const SCAN_SELECTORS = ['[role="button"]'];

const ACTION_LABELS = ["Like", "Comment", "Share", "Send"];

// Facebook's OWN Like/Comment button labels in all 26 shipped UI locales, read
// off facebook.com one locale per page load - never translated. Exact forms
// rather than stems: Facebook ships one string per action per locale, so
// equality carries the locale with no substring risk, and the 3 label shapes
// matchesActionLabel documents are handled by localizedActionLabel below.
// Only these 2 are readable without a session - a logged-out post renders no
// Share/Send button - so those stay on the EN list plus the EN/RU/UA stems.
// Why the pair is worth it: resolvePostAction drops to the geometry fallback
// ONLY for labels it cannot read, and findPostContainer then refuses to walk out
// to a permalink (`viaGeometryFallback`), so in an unreadable locale every post
// whose action row sits outside `[role="article"]` gets no picker at all.
export const FB_LOCALIZED_ACTION_LABELS: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["Like", ["Like", "Curtir", "Gefällt mir", "Gilla", "J’aime", "Liker", "Me gusta", "Meeldib", "Mi piace", "Patinka", "Polub", "Suka", "Synes godt om", "Tetszik", "Thích", "Tykkää", "Vind ik leuk", "Подобається", 'Поставить "Нравится"', "लाइक करें", "লাইক করুন", "ถูกใจ", "좋아요", "「いいね！」", "讚", "赞"]],
  [
    "Comment",
    [
      "Comment",
      "Bình luận",
      "Comentar",
      "Commenta",
      "Commenter",
      "Hozzászólás",
      "Komen",
      "Komentuoti",
      "Kommentar",
      "Kommenteeri",
      "Kommenter",
      "Kommentieren",
      "Kommentoi",
      "Opmerking plaatsen",
      "Skomentuj",
      "Коментувати",
      "Комментировать",
      "कमेंट करें",
      "কমেন্ট করুন",
      "แสดงความคิดเห็น",
      "댓글",
      "コメントする",
      "留言",
      "评论",
    ],
  ],
];

// Whitespace and NFC before comparing, not just case: Facebook separates the
// German "Gefällt mir" with a NO-BREAK space and can serve the "ä" decomposed,
// so page and literal print identically while `===` is false - German fell
// through to geometry until both sides were normalized (verified live).
function normalizeLabel(label: string): string {
  return collapseWhitespace(label).normalize("NFC").toLowerCase();
}

// Normalized label -> canonical action, so a button costs one map lookup rather
// than a walk over 50 strings. The global `[role="button"]` sweep visits hundreds
// of buttons per re-scan; see the cost note on readPostActionLikeButton.
const LOCALIZED_LABEL_KIND: ReadonlyMap<string, string> = new Map(FB_LOCALIZED_ACTION_LABELS.flatMap(([canonical, forms]) => forms.map((form) => [normalizeLabel(form), canonical] as const)));

// The label asymmetry every post-vs-comment verdict in this module rests on: a
// post action row pairs Like with Comment/Share/Send, a comment row pairs it with
// Reply alone. Stated once here; the readers below reference it rather than
// restate it.
const ROW_SIBLING_LABELS_SET: ReadonlySet<string> = new Set(["Comment", "Share", "Send"]);

// Canonical action <-> locale-stem matchers via the shared label engine
// (action-labels.ts). Facebook localizes BOTH the aria-label and the visible text
// of its action buttons, so English-only signals (POST_LIKE_ARIA, exact "Like")
// never fire on a RU/UA UI - the adapter would fall back to fragile geometry and
// mount on comment rows / skip posts. Our FB stems cover EN/RU/UA only (no
// German), composed narrowed from STEM_PARTS rather than the wider STEM union.
// The exact EN `ACTION_LABELS` are still checked FIRST in actionLabel
// (their prefix-aware match - "Like Mark's post" -> "Like" - is not expressible as
// the registry's exact equality), so an exact English label always wins.
export const FB_STEMS = {
  like: stem(STEM_PARTS.like.en, STEM_PARTS.like.ru, STEM_PARTS.like.ua),
  comment: STEM.comment,
  share: stem(STEM_PARTS.share.en, STEM_PARTS.share.ru, STEM_PARTS.share.ua),
  send: STEM.send,
  reply: stem(STEM_PARTS.reply.en, STEM_PARTS.reply.ru, STEM_PARTS.reply.ua),
} as const;

// A set reaction relabels the Like button "Remove Like"/"Remove Love"/... (EN),
// «Убрать/Удалить...» (RU), «Видалити/Скасувати...» (UA) - our stems cover EN/RU/UA
// here, same as above. Read both for auto-press (fbLikePressed) and, via
// actionLabel, to keep recognizing a REACTED post's like control.
export const FB_REMOVE_RE = /^(remove|убрать|удалить|видалити|скасувати)/i;

// Facebook splits the like control into TWO buttons: the Like/count button and a
// small chevron beside it that opens the 7-reaction flyout. Both relabel once a
// reaction is set:
//   unreacted -> "Like"        + "React"
//   reacted   -> "Remove Haha" + "Change Haha reaction"
// The chevron must NOT read as a Like: "Change Like reaction" matches the like
// stem, so a liked post exposed TWO post-action Likes - countPostActionLikeButtons
// returned 2 and findLocalStoryContainer (needs exactly 1) / widenToPostUnit
// (breaks above 1) then refused the post unit. A Page-wall post has no
// [role="article"] and only a lazy `__cft__` date link, leaving findPostContainer
// nothing to fall back on, so the picker disappeared entirely (verified live on
// facebook.com/allo). "React" already reads as no action; only the localized
// "...reaction" forms need rejecting.
export const FB_REACTION_MENU_ARIA = /\breaction\b|реакц/iu;

// The same chevron, recognized by its ICON instead of its wording - the regex
// above only knows EN/RU/UA, and a locale whose "change reaction" phrasing
// happens to carry the like word would hand the post a second Like. Facebook
// draws the Like as a CSS-sprite <i> and the chevron as this inline path, in
// BOTH states (captured live, idle and reacted).
const REACTION_CHEVRON_ICON_PATH = "M4.708 6c-1.114 0-1.672 1.346";

export function isReactionChevron(el: Element): boolean {
  const path = el.querySelector("svg path[d]")?.getAttribute("d");
  return path != null && collapseWhitespace(path).startsWith(REACTION_CHEVRON_ICON_PATH);
}

// The chevron sits ONLY beside a post's Like, the two of them alone in a wrapper
// (verified live on the feed, a Page wall and a permalink, idle and reacted; a
// comment's Like never gets one). So the control paired with a chevron IS the
// Like whatever its label says - which is what keeps the trigger on a REACTED
// post in a locale whose "Remove <reaction>" wording FB_REMOVE_RE cannot read.
const CHEVRON_PAIR_WALK_DEPTH = 2;
const CHEVRON_PAIR_MAX_CHILDREN = 4;

function isChevronPairedLike(el: Element): boolean {
  if (isReactionChevron(el)) return false;
  let node: Element | null = el;
  for (let up = 0; up < CHEVRON_PAIR_WALK_DEPTH && node; up++) {
    const parent: Element | null = node.parentElement;
    if (!parent || parent.children.length > CHEVRON_PAIR_MAX_CHILDREN) return false;
    let chevrons = 0;
    let others = 0;
    for (const child of Array.from(parent.children)) {
      const control = child.matches('[role="button"]') ? child : child.querySelector('[role="button"]');
      if (!control) continue;
      if (isReactionChevron(control)) chevrons += 1;
      else others += 1;
    }
    if (chevrons === 1 && others === 1) return true;
    node = parent;
  }
  return false;
}

// An unreadable label reads UNKNOWN (null) - see the likePressed contract in
// shared/adapter.ts.
export function fbLikeLabelPressed(label: string): boolean | null {
  if (!label) return null;
  if (FB_REMOVE_RE.test(label)) return true;
  if (label === "Like" || FB_STEMS.like.test(label)) return false;
  return null;
}

export function fbLikePressed(btn: HTMLElement): boolean | null {
  return fbLikeLabelPressed(btn.getAttribute("aria-label")?.trim() ?? "");
}

// The OPENED reactions flyout for auto-press: a dialog holding >= 7 labelled
// buttons whose FIRST is the Like entry (checked via the like stem, so the
// localized dialog aria-label is never consulted). Returns the 7 reaction
// buttons in flyout-position order - position, not label, identifies them
// (the buttons render a bare <canvas>; labels localize).
export function findFbReactionsMenu(): HTMLElement[] | null {
  for (const dlg of Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]'))) {
    const buttons = Array.from(dlg.querySelectorAll<HTMLElement>('[role="button"][aria-label]'));
    if (buttons.length < 7) continue;
    const firstLabel = buttons[0]?.getAttribute("aria-label")?.trim() ?? "";
    if (firstLabel === "Like" || FB_STEMS.like.test(firstLabel)) return buttons.slice(0, 7);
  }
  return null;
}

const fbLabels = defineLabelRegistry(
  {
    like: { exact: ["Like"], stems: FB_STEMS.like },
    comment: { exact: ["Comment"], stems: FB_STEMS.comment },
    share: { exact: ["Share"], stems: FB_STEMS.share },
    send: { exact: ["Send"], stems: FB_STEMS.send },
    reply: { stems: FB_STEMS.reply },
  },
  {
    useTextFallback: true,
    readDescendantSvgLabels: false,
    rejectCountSummary: true,
    controlSelector: '[role="button"]',
  },
);

// Canonical post-action kinds -> the label strings `actionLabel` returns. Reply
// classifies (for comment-row detection) but is NOT a post action, so it maps to null.
const FB_KIND_LABEL: Partial<Record<ActionKind, string>> = {
  like: "Like",
  comment: "Comment",
  share: "Share",
  send: "Send",
};

const fbCommentRowReject = rejectCommentRow(["comment", "share", "send"], "reply");

// Text labels marking the VISITOR view of a profile/page header - Follow /
// Message / Add friend / Subscribe / Join and their RU/UA forms - which pair a
// Like/Follow with page-level CTAs instead of Comment/Share/Send. The OWNER's own
// header (Add to story / Edit profile) carries no Like, is reached only via the
// language-blind geometry fallback, and is matched structurally instead (see
// PROFILE_HEADER_CTA_SELECTOR).
const HEADER_CTA_STEM =
  /follow|following|message|subscribe|subscribed|invite|\bjoin\b|\bjoined\b|\bshop\b|\brespond\b|\bfriend request\b|\badd friend\b|\bconfirm request\b|\bdelete request\b|\bcancel request\b|\bremove friend\b|\bunfriend\b|подпис|підпис|стеж|сообщ|повідом|вступ|приєдн|приглас|запрос|запрош|в\s+групп|у\s+груп|магазин|добав.*друз|подтверд.*(?:запрос|заяв)|удал.*(?:запрос|заяв)|підтверд.*запит|видал.*запит|скас.*запит/iu;

// The owner's profile-header CTAs are anchors to Facebook routes (story composer,
// profile-edit entry) that stay identical in EVERY UI language, unlike localized
// button text. Neither route ever appears in a post's action row, so either one in
// a candidate row proves a profile header - which stops the language-blind
// geometry fallback mounting a picker beside the profile name on the owner's page.
const PROFILE_HEADER_CTA_SELECTOR = 'a[href*="/stories/create"], a[href*="fb_profile_edit_entry_point"]';

// Owner tools are route-based for the same reason: the Boost control is an
// anchor into the ad centre in every UI language (captured live on an owned
// Page), while OWNER_TOOLS_STEM below can only spell EN/RU/UA. A post action row
// never links there.
const OWNER_TOOLS_SELECTOR = 'a[href*="/ad_center/"]';

const FEED_PROMPT_STEM = /are you interested in this post|are you interested in this publication|вас интересует эта публикация|вас цікавить ця публікація/iu;

const AI_PROMPT_CHIP_STEM = /\b(?:how|what|why|when|where|who|which|can|could|should|would|will|does|do|did|is|are)\b[^?]{0,140}\?/iu;

// Every composer label FB ships in EN/RU/UA must match, no post action label may.
export const COMPOSER_ACTION_STEM = /\banonymous post\b|\bfeeling\s*\/\s*activity\b|\bpoll\b|\bphoto\s*\/\s*video\b|\blive video\b|\blife (?:update|event)\b|\bwrite something\b|аноним[а-яё]*\s+(?:публикац|пост)|опрос|опитув|фото\s*\/\s*(?:видео|відео)|чувств|почутт|эфир|ефір|світлин|життєв|событи[ея]\s+из\s+жизни/iu;

// Page/profile-admin tools rendered as a separate row under the admin's OWN post:
// "View insights" / "Boost post" / "Create ad" (+ RU/UA forms). Neither label
// reads as a post action, so the two wide buttons pass the geometry fallback and
// a SECOND picker mounted in that row above the real one, stealing the post's
// canonical photo key (the real row then re-keyed onto the CFT fallback). Never a
// post action row.
const OWNER_TOOLS_STEM = /\binsights\b|\bboost\b|\bpromote\b|\bcreate ad\b|статистик|объявлени|оголошен|продвига|просува|реклам/iu;

// actionRowSlot's upward walk: 10 levels is safe because the FIRST ancestor with
// >=2 action labels wins (no "escape" risk for that walk).
const ROW_WALK_DEPTH = 10;

const VISUAL_ROW_WALK_DEPTH = 8;

// Reel viewer only: how far up to look for the vertical action column. Verified
// live: the column with >=2 action labels sits ~3 levels above the Like. Kept
// SHALLOW so a comment-panel Like can't walk up and borrow the reel's column.
export const REEL_ACTION_COLUMN_DEPTH = 6;

// The bounded sibling check MUST stay shallow: walking too far up reaches the
// comments-section/post-content parent and spuriously discovers the real action
// row from a comment row - false-positive comment Likes.
const SIBLING_UP_DEPTH = 3;

const SIBLING_DOWN_DEPTH = 4;

// Modern post-action-row Like aria-label: "Like Mark Zuckerberg's post" (or
// photo/video/reel/...). Comment-row Likes get just "Like", so this is unambiguous.
// The trailing `\w+` lets the suffix be any noun word, not just an enumerated list.
const POST_LIKE_ARIA = /^Like\s.+['’]s\s+\w+/i;

// Per-scan memo. `countPostActionLikeButtons` runs the verdict over every
// [role="button"] in a subtree, and the two ancestor walks that call it
// (findLocalStoryContainer, widenToPostUnit) repeat that over up to
// STORY_CONTAINER_WALK_DEPTH growing ancestors - so one post otherwise pays the getBoundingClientRect +
// getComputedStyle walk below hundreds of times, which is the same cost the
// label-first rejection in the verdict was added to avoid. Reset per scan and
// per photo click (both in facebook.ts): a Like relabels itself the moment the
// user reacts, so a verdict must not outlive the pass that took it.
let postActionLikeCache = new WeakMap<HTMLElement, boolean>();

export function resetPostActionLikeCache(): void {
  postActionLikeCache = new WeakMap<HTMLElement, boolean>();
}

export function isPostActionLikeButton(btn: HTMLElement): boolean {
  const cached = postActionLikeCache.get(btn);
  if (cached !== undefined) return cached;
  const verdict = readPostActionLikeButton(btn);
  postActionLikeCache.set(btn, verdict);
  return verdict;
}

// Facebook renders the action Like in several label shapes (enumerated on
// matchesActionLabel below); periodic React redeploys drop tabindex, swap the
// outer tag (div -> span), or restructure parent flex chains. A reactions-summary
// icon (`aria-label="Like: 68 people"`) also exists atop the comments and must be
// rejected.
//
// Detection is intentionally selector-light, on the two signals stable across
// every redeploy since 2017 because they're accessibility-required:
// `role="button"` and `aria-label="Like"` (else visible text exactly "Like").
// Post-row vs comment-row is then decided by the ROW_SIBLING_LABELS_SET
// asymmetry, read within a shallow sibling window (see SIBLING_UP_DEPTH).
function readPostActionLikeButton(btn: HTMLElement): boolean {
  // Cheap label/aria rejection FIRST: the global `[role="button"]` scan visits
  // hundreds of buttons per re-scan, and paying isRenderableInPageLayout's rect +
  // computed-style walk on each was a primary cause of the "button appears with a
  // growing delay" bug. Renderability is still required for every ACCEPTED button.
  const aria = btn.getAttribute("aria-label");
  // Reaction-count summaries read "Like: 68 people" - reject. (A localized
  // post-Like aria without a count, e.g. "Нравится", still reaches the stem
  // check below.)
  if (aria && isCountSummary(aria)) return false;
  if (aria && POST_LIKE_ARIA.test(aria)) return isRenderableInPageLayout(btn);
  // Locale-independent path: a Like-labeled control (EN/RU/UA/...) still has to
  // prove a nearby row sibling, which is what catches posts whose labels
  // Facebook has localized without letting a comment's Like through.
  if (actionLabel(btn) !== "Like") return false;
  return isRenderableInPageLayout(btn) && hasBoundedActionRowSibling(btn);
}

// Post action rows are FLAT in Facebook's design system: Like/Comment/Share/Send
// render with no background fill in every UI language and theme (base state;
// hover paints an overlay). Standalone CTA chips - profile/page-header
// Follow/Message, AI comment-prompt suggestions, composer shortcuts - are
// FILLED pills. The text guards in isNonPostActionRow enumerate wording, so any
// language or copy Facebook ships next slips through them (verified live: the
// UA header's "Стежити" and a questionless EN AI-prompt row both mounted);
// the fill probe is their language-independent counterpart. Two filled slots
// are required so a hover overlay caught mid-scan on ONE real action button
// can't reject a genuine row.
const FILLED_SLOT_REJECT_COUNT = 2;

// The pill's fill can sit on an inner wrapper rather than on the
// [role="button"] element itself; probe a few descendant levels.
const FILLED_PROBE_DEPTH = 3;

export function isFilledChipRow(slots: HTMLElement[]): boolean {
  let filled = 0;
  for (const slot of slots) {
    if (slotHasFilledControl(slot)) {
      filled += 1;
      if (filled >= FILLED_SLOT_REJECT_COUNT) return true;
    }
  }
  return false;
}

function slotHasFilledControl(slot: HTMLElement): boolean {
  const control = slot.matches('[role="button"]') ? slot : slot.querySelector<HTMLElement>('[role="button"]');
  if (!control) return false;
  let frontier: HTMLElement[] = [control];
  for (let depth = 0; depth <= FILLED_PROBE_DEPTH && frontier.length > 0; depth++) {
    const next: HTMLElement[] = [];
    for (const el of frontier) {
      if (hasBackgroundFill(el)) return true;
      for (const child of Array.from(el.children)) {
        if (child instanceof HTMLElement) next.push(child);
      }
    }
    frontier = next;
  }
  return false;
}

// An unreadable background-color (null) reads as no fill - a chip is only
// rejected on positive evidence of paint. The alpha read itself lives in
// css-alpha.ts, shared with the Threads liked-state heart.
function hasBackgroundFill(el: HTMLElement): boolean {
  return isPaintedFill(getComputedStyle(el).backgroundColor) === true;
}

export function isNonPostActionRow(row: HTMLElement): boolean {
  if (hasProfileHeaderCta(row)) return true;
  if (row.querySelector(OWNER_TOOLS_SELECTOR)) return true;
  const rowText = localizedActionText(row) || textOf(row);
  if (FEED_PROMPT_STEM.test(rowText) || AI_PROMPT_CHIP_STEM.test(rowText)) return true;

  // ONE sweep over the row's buttons, shared by the three checks below: this runs
  // per CANDIDATE and findCandidates hands over every button on the page, so four
  // separate `[role="button"]` walks cost exactly what the label-first rejection
  // in readPostActionLikeButton exists to avoid.
  const buttons = Array.from(row.querySelectorAll<HTMLElement>('[role="button"]'));
  const buttonTexts = buttons.map((btn) => localizedActionText(btn) || textOf(btn));

  if (buttonTexts.some((text) => COMPOSER_ACTION_STEM.test(text) || OWNER_TOOLS_STEM.test(text))) return true;
  if (!HEADER_CTA_STEM.test(rowText) && !buttonTexts.some((text) => HEADER_CTA_STEM.test(text))) return false;

  // Page/profile headers pair Like/Follow with Message/Subscribe/Join CTAs -
  // page-level actions that must never receive a per-post reaction picker - so
  // the row must still satisfy the ROW_SIBLING_LABELS_SET asymmetry.
  const labels = new Set<string>();
  for (const btn of buttons) {
    const label = actionLabel(btn);
    if (label) labels.add(label);
  }
  if (!labels.has("Like")) return true;
  for (const label of labels) if (ROW_SIBLING_LABELS_SET.has(label)) return false;
  return true;
}

// Route-based, so it holds in every FB UI language (see PROFILE_HEADER_CTA_SELECTOR).
function hasProfileHeaderCta(root: HTMLElement): boolean {
  return root.querySelector(PROFILE_HEADER_CTA_SELECTOR) !== null;
}

// One dialog vocabulary for all three readers: the container walk bound, the shared-photo
// re-key gate, and the Messenger rejection. A role added to only some of them desynchronizes
// them.
export const MODAL_SELECTOR = '[role="dialog"], [role="alertdialog"]';

// The Messenger surface can nest its composer several levels above the button;
// cap the ancestor walk instead of climbing the whole page.
const MESSENGER_WALK_DEPTH = 25;

// The Messenger chat popup renders a composer and per-message hover actions
// whose geometry mimics a post action row - but a conversation is never a post.
// Signature (verified live on a Marketplace popup): a `position: fixed` floating
// surface (the in-page feed never is) containing a `role="region"` message
// composer. Post-in-a-dialog (photo viewer / permalink modal) is `role="dialog"`
// and handled by findPostContainer's modal containment, so dialogs are excluded
// here to avoid rejecting real posts.
export function isInMessengerThread(el: HTMLElement): boolean {
  for (const node of ancestors(el, MESSENGER_WALK_DEPTH)) {
    if (isFixedPositioned(node) && !node.matches(MODAL_SELECTOR) && containsMessageComposer(node)) {
      return true;
    }
  }
  return false;
}

function isFixedPositioned(el: HTMLElement): boolean {
  return getComputedStyle(el).position === "fixed";
}

// A message composer is a `role="region"` wrapping a contenteditable textbox.
// Posts/photo-viewers render their comment box as a bare textbox (no region),
// so this stays specific to chat threads and won't catch a post's comments.
function containsMessageComposer(root: Element): boolean {
  for (const region of root.querySelectorAll('[role="region"]')) {
    if (region.querySelector('[role="textbox"], [contenteditable="true"]')) {
      return true;
    }
  }
  return false;
}

// See rejectCommentRow: positive recognition only.
export function looksLikeCommentRow(row: HTMLElement): boolean {
  return fbCommentRowReject(row, fbLabels);
}

// A control inside a NESTED [role="article"] is a comment's: Facebook wraps
// every comment in its own article INSIDE the post's article (verified live on
// the feed and on permalink/modal surfaces - post controls sit at article
// depth 1, comment controls at depth 2). This is the structural, language-blind
// backstop the label guards can't be: a comment's reaction cluster (bare
// localized Like aria + a count as text) sitting near the TOP of its comment
// can reach the POST's own counts row within the sibling walk and borrow the
// genuine, text-bearing comment-count chip there as its "post row" proof -
// which mounted a picker on the first comment under a post (user report,
// reproduced by injection). Posts themselves never nest: a standalone
// photo/reel viewer has no article at all and a feed/permalink post's article
// is top-level, so the guard cannot cost a real post its trigger.
export function isInNestedArticle(el: HTMLElement): boolean {
  const article = el.closest('[role="article"]');
  if (!article) return false;
  return article.parentElement?.closest('[role="article"]') != null;
}

export function findFacebookVisualActionSlot(btn: HTMLElement): VisualActionSlot | null {
  if (btn.getAttribute("role") !== "button") return null;
  if (btn.closest(OWN_NODES_SELECTOR)) return null;
  if (!textOf(btn)) return null;
  const aria = btn.getAttribute("aria-label");
  if (aria?.includes(":")) return null;

  return findVisualActionSlot(btn, {
    maxDepth: VISUAL_ROW_WALK_DEPTH,
    minSlots: 2,
    maxSlots: 4,
    minRowWidth: 220,
    maxRowHeight: 72,
    minSlotWidth: 96,
    minSlotHeight: 24,
    maxWidthVariance: 0.35,
    controlSelector: '[role="button"]',
    boundary: isStructuralRoot,
  });
}

// Ancestor ceiling for the single-post story walks (findLocalStoryContainer,
// widenToPostUnit): deep enough to reach the post unit, shallow enough to stop
// before crossing into a neighbouring post.
const STORY_CONTAINER_WALK_DEPTH = 16;

export function findLocalStoryContainer(start: HTMLElement): HTMLElement | null {
  for (const node of ancestors(start, STORY_CONTAINER_WALK_DEPTH)) {
    if (isStructuralRoot(node)) return null;
    if (countPostActionLikeButtons(node) === 1 && hasLocalStoryMarker(node)) {
      return node;
    }
  }
  return null;
}

function countPostActionLikeButtons(root: ParentNode): number {
  let count = 0;
  for (const button of root.querySelectorAll<HTMLElement>('[role="button"]')) {
    if (isPostActionLikeButton(button)) count += 1;
  }
  return count;
}

function hasLocalStoryMarker(root: ParentNode): boolean {
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[href], a[role="link"]')) {
    const href = link.getAttribute("href") || link.href;
    if (normalizePostHref(href) || normalizePhotoHref(href) || normalizeCftHref(href)) {
      return true;
    }
  }
  return false;
}

// The WIDEST ancestor of the action row still belonging to ONE post (its only
// post-action Like is this one). `findPostContainer` returns the FIRST ancestor
// with a post link - on a permalink page that's the date-link wrapper, which sits
// BELOW the post's photo and hides it from photo-first resolution (the post would
// then key on its pfbid, diverging from the feed/photo-viewer's `photo:<media>`).
// Stopping at a second post-action Like guarantees we never cross into a
// neighbouring (e.g. "Suggested") post.
export function widenToPostUnit(actionRow: HTMLElement, fallback: HTMLElement): HTMLElement {
  let widest: HTMLElement | null = null;
  for (const node of ancestors(actionRow, STORY_CONTAINER_WALK_DEPTH)) {
    if (isStructuralRoot(node)) break;
    const likes = countPostActionLikeButtons(node);
    if (likes > 1) break;
    if (likes === 1) widest = node;
  }
  return widest ?? fallback;
}

export function actionLabel(el: Element): string | null {
  const aria = el.getAttribute("aria-label");
  if (aria) {
    // A pressed Like keeps its role under the reaction's own noun ("Remove Haha").
    // Checked BEFORE the chevron rejection: the RU/UA remove labels spell the word
    // "reaction" out («Убрать реакцию...», «Видалити реакцію...»), so the реакц test
    // below would misread a reacted post's Like as the flyout chevron and the
    // trigger vanished from every reacted post on those locales (EN "Remove Like"
    // never contains "reaction", which is why only they broke). The chevron's own
    // labels are Change-forms ("Change Haha reaction", «Змінити/Изменить
    // реакцию...») - no remove verb, so they still fall through to the rejection.
    // Still gated by hasBoundedActionRowSibling downstream, so an unrelated
    // "Remove ..." control outside an action row cannot pass as a post Like.
    if (FB_REMOVE_RE.test(aria)) return "Like";
    // The reactions-flyout chevron sits in the like slot but is not the Like.
    if (FB_REACTION_MENU_ARIA.test(aria)) return null;
  }
  // Icon-based chevron rejection, ahead of every label read: it holds in the
  // locales the regex above cannot spell, where a "change reaction" wording that
  // carries the like word would otherwise make the post expose two Likes.
  if (isReactionChevron(el)) return null;
  // EN exact list wins (prefix-aware, checked before the locale-stem fallback).
  for (const lbl of ACTION_LABELS) {
    if (matchesActionLabel(el, lbl)) return lbl;
  }
  // Then the shipped string for this locale - a label Facebook actually renders
  // is a stronger signal than a morphological root.
  const localized = localizedActionLabel(el);
  if (localized) return localized;
  // Locale-stem fallback for RU/UA (and any inflected EN form), via the shared label engine.
  const kind = fbLabels.classify(el);
  if (kind) return FB_KIND_LABEL[kind] ?? null;
  // Last resort, no wording involved: paired with the reactions chevron. This is
  // the only path that reads a REACTED post's Like in a locale we have no
  // "Remove <reaction>" vocabulary for.
  return isChevronPairedLike(el) ? "Like" : null;
}

// matchesActionLabel's 3 shapes against LOCALIZED_LABEL_KIND, reading the aria
// and the text ONCE - the same lookup done per candidate label would re-read
// textContent 50 times per button.
function localizedActionLabel(el: Element): string | null {
  const aria = el.getAttribute("aria-label");
  if (aria?.includes(":")) return null;
  const text = normalizeLabel(el.textContent || "");
  if (!aria) return LOCALIZED_LABEL_KIND.get(text) ?? null;
  const normalizedAria = normalizeLabel(aria);
  const byAria = LOCALIZED_LABEL_KIND.get(normalizedAria);
  if (byAria) return byAria;
  // Owner-suffix aria ("Gefällt mir Marks Beitrag"): the visible text carries the
  // bare label, so confirm the suffix belongs to it rather than to another button.
  const byText = LOCALIZED_LABEL_KIND.get(text);
  return byText && normalizedAria.startsWith(`${text} `) ? byText : null;
}

// The label text we run stem matching against: the aria-label when present
// (minus reaction-count summaries like "Like: 68"), else the visible text.
function localizedActionText(el: Element): string {
  const aria = el.getAttribute("aria-label");
  if (aria) return isCountSummary(aria) ? "" : aria;
  return (el.textContent || "").trim();
}

// The three label shapes Facebook ships today:
//   1. `aria-label="Like"` - exact (comment rows, simple variants).
//   2. `aria-label="Like Mark Zuckerberg's post"` - modern post row; the visible
//      text is still just "Like" (Comment/Share/Send use the same suffix form).
//   3. No aria-label, visible text === "Like" - logged-out variant.
// Count summaries ("Like: 68 people") are rejected via the colon check.
function matchesActionLabel(el: Element, label: string): boolean {
  const aria = el.getAttribute("aria-label");
  if (aria?.includes(":")) return false;
  if (aria === label) return true;
  const text = (el.textContent || "").trim();
  if (!aria) return text === label;
  // Owner-suffix aria ("Like Mark's post"): confirm via visible text so unrelated
  // buttons whose aria-label merely starts with the word aren't picked up.
  if (aria.startsWith(`${label} `)) return text === label;
  return false;
}

// Walk up a SHALLOW window of ancestors (bounded by SIBLING_UP_DEPTH, which
// carries the escape rationale), checking only the IMMEDIATE child siblings of
// the current branch - all descendants would escape the same way - each searched
// down to SIBLING_DOWN_DEPTH for a row marker.
// Fallback for every Like whose aria is not the English owner-suffix form
// POST_LIKE_ARIA handles: no-aria (logged-out) text Likes, bare aria="Like",
// reacted "Remove <reaction>", and all localized labels.
//
// Decided PER LEVEL, nearest first, and a Reply marker outvotes a row marker at
// its level: a comment's Like meets its own Reply link at the first level, while
// the comment COMPOSER a couple of levels up carries buttons whose aria spells
// "comment" out ("Comment with a GIF", «Коментувати з GIF») and reads as a row
// marker - one route into the comment escape isInNestedArticle documents. A real
// post action row meets Comment/Share/Send at its first marker level and never a
// Reply, so it still resolves at that level.
function hasBoundedActionRowSibling(el: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  for (let up = 0; up < SIBLING_UP_DEPTH; up++) {
    const parent: HTMLElement | null = node?.parentElement ?? null;
    if (!parent) return false;
    let row = false;
    let reply = false;
    for (const sib of Array.from(parent.children) as HTMLElement[]) {
      if (sib === node) continue;
      const marker = containsRowOrReplyMarker(sib, SIBLING_DOWN_DEPTH);
      if (marker === "reply") reply = true;
      else if (marker === "row") row = true;
    }
    if (reply) return false;
    if (row) return true;
    node = parent;
  }
  return false;
}

// The ROW_SIBLING_LABELS_SET check without the sibling walk - for reel-viewer
// detection, where the column's buttons sit too deep for it.
export function rowHasPostSibling(row: HTMLElement): boolean {
  for (const btn of row.querySelectorAll<HTMLElement>('[role="button"]')) {
    const label = actionLabel(btn);
    if (label && ROW_SIBLING_LABELS_SET.has(label)) return true;
  }
  return false;
}

// Bounded BFS for a Comment/Share/Send ("row") or Reply marker, so a deep
// ancestor doesn't traverse a whole post subtree. Reply wins over a row marker
// in the same subtree: hasBoundedActionRowSibling treats it as proof of a
// comment row, and a subtree holding both (a comment thread) must not read as a
// post action row.
//
// Icon-only markers COUNT: a group photo-attachment's action row labels its
// Comment/Send as bare icons (aria «Залишити коментар» / «Надіслати», no text -
// verified live on a public group's photo post, where a previous
// text-required rule left the whole post without its trigger). Safe because the
// comment surfaces that abuse the same aria are rejected structurally instead -
// isInNestedArticle (checked before every branch) plus the Reply their classic
// link row carries, which outranks any row marker here.
function containsRowOrReplyMarker(root: Element, maxDepth: number): "row" | "reply" | null {
  let row = false;
  let frontier: Element[] = [root];
  for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: Element[] = [];
    for (const element of frontier) {
      if (fbLabels.classify(element) === "reply") return "reply";
      const label = actionLabel(element);
      if (label && ROW_SIBLING_LABELS_SET.has(label)) row = true;
      for (const child of Array.from(element.children)) next.push(child);
    }
    frontier = next;
  }
  return row ? "row" : null;
}

// Walk up until the parent contains >=2 distinct action-labeled buttons - that
// parent is the flex action row and `node` the column slot to anchor on (the
// picker becomes a sibling flex item between Like and Comment).
export function actionRowSlot(likeBtn: HTMLElement, maxDepth = ROW_WALK_DEPTH): HTMLElement | null {
  let node: HTMLElement | null = likeBtn;
  for (let i = 0; i < maxDepth && node; i++) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent) return null;
    if (countActionButtons(parent) >= 2) return node;
    node = parent;
  }
  return null;
}

function countActionButtons(container: Element): number {
  const seen = new Set<string>();
  for (const child of Array.from(container.children)) {
    const lbl = actionLabelInActionSlot(child);
    if (lbl) seen.add(lbl);
  }
  return seen.size;
}

function actionLabelInActionSlot(slot: Element): string | null {
  const own = actionLabel(slot);
  if (own) return own;
  for (const btn of slot.querySelectorAll<HTMLElement>('[role="button"]')) {
    const label = actionLabel(btn);
    if (label) return label;
  }
  return null;
}
