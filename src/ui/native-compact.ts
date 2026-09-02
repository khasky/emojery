// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shortening native like text when adding the trigger overflows a narrow action row (IG detail
// "327 555" spilling past the post's edge). Moves or hides nothing: only compacts the two kinds
// of like text whose width we may reduce - a bare COUNT ("327 555" -> "327K") and a verbose
// LABEL with its short name in quotes.
import { elementsToArray, type PickerInsertionPoint } from "../shared/adapter";
import { OWN_NODES_SELECTOR } from "../shared/dom";
import { queryAllDeep } from "../shared/dom-query";

// Original counter text, stamped on the counter's parent element so the change
// is idempotent and reversible (see restoreCompactedCounts).
const COUNT_ATTR = "data-khasky-emojery-count";
const COUNT_ATTR_SELECTOR = `[${COUNT_ATTR}]`;

// A bare integer counter: plain digits, or three-digit groups joined by a locale separator
// (space/NBSP/narrow spaces, comma, dot, apostrophe). Anything carrying a letter ("12.3K",
// "1 234 likes") is left alone; a dot between three-digit groups reads as a separator, so a
// true decimal in that exact shape ("327.555") counts as 327555.
const GROUPED_COUNT_RE = /^(?:\d+|\d{1,3}(?:[ ,.'’   ]\d{3})+)$/;

// A counter the site ALREADY compacted, but with a Cyrillic suffix - X in RU/UA
// renders "5 тис." / "682,1 тыс." / "1,2 млн", wider than the Latin form the
// narrow photo/video-view rows fit. Suffix -> K/M/B, decimal comma -> dot; the EN
// "5K" is already minimal and never matches.
const CYRILLIC_COMPACT_RE = /^(\d+(?:[.,]\d+)?)\s*(тис|тыс|млн|млрд)\.?$/iu;
const CYRILLIC_SUFFIX_LATIN: Record<string, string> = { тис: "K", тыс: "K", млн: "M", млрд: "B" };

// Largest unit that still shortens the text; the suffixes match what the Cyrillic map above
// produces. One decimal below 100 of a unit ("11.9M"), none above it ("112M").
const COMPACT_TIERS: readonly { unit: number; suffix: string }[] = [
  { unit: 1_000_000_000, suffix: "B" },
  { unit: 1_000_000, suffix: "M" },
  { unit: 1_000, suffix: "K" },
];

// "327 555" -> "327K" (truncated, mirroring how platforms round counters down). Null when
// the text isn't a plain counter or the compact form wouldn't actually be shorter.
export function compactCountText(raw: string): string | null {
  const text = raw.trim();
  const cyrillic = text.match(CYRILLIC_COMPACT_RE);
  if (cyrillic) {
    const compact = `${cyrillic[1]!.replace(",", ".")}${CYRILLIC_SUFFIX_LATIN[cyrillic[2]!.toLowerCase()]}`;
    return compact.length < text.length ? compact : null;
  }
  if (!GROUPED_COUNT_RE.test(text)) return null;
  const n = Number(text.replace(/\D/g, ""));
  if (!Number.isFinite(n)) return null;
  const tier = COMPACT_TIERS.find((t) => n >= t.unit);
  if (!tier) return null;
  const compact = `${truncated(n / tier.unit, n < tier.unit * 100)}${tier.suffix}`;
  return compact.length < text.length ? compact : null;
}

function truncated(value: number, oneDecimal: boolean): string {
  if (!oneDecimal) return String(Math.floor(value));
  return String(Math.floor(value * 10) / 10).replace(/\.0$/, "");
}

// A verbose action label carrying its own short form in quotes - FB wraps the reaction
// name this way in several locales (RU «Поставить "Нравится"»). The quoted core IS the
// site's short name, so extracting it shortens the label without inventing a translation.
const QUOTED_LABEL_RE = /^[^"«„“”]*["«„“]([^"«»„“”]{2,})["»“”]$/u;

export function compactQuotedLabelText(raw: string): string | null {
  const text = raw.trim();
  const core = text.match(QUOTED_LABEL_RE)?.[1]?.trim();
  if (!core || core.length >= text.length) return null;
  return core;
}

// Sub-pixel rounding slack: a real overflow spills more than this, a rounded
// scrollWidth alone never does.
const OVERFLOW_EPSILON_PX = 2;

// Compact only when the row - or a native control itself - actually overflows
// BECAUSE OF the trigger; a roomy row keeps the site's own full text. The
// second measurement with the host hidden is the attribution: some Threads
// feed cards report a constant ~24px ancestor overflow with no trigger at all
// (verified live), and compacting on that painted random posts "2.6K" while
// identical neighbours kept "24 540". Overflow that persists without the host
// is the site's own layout and never ours to fix.
export function compactNativeCountsOnOverflow(host: HTMLElement, point: PickerInsertionPoint): void {
  const overflows = () => rowOverflows(host) || nativeOverflows(point);
  if (!overflows()) return;
  // Out-of-flow, NOT display:none: the probe reruns on every reblend pass, and
  // display:none cancels-and-restarts the host's own CSS animations - on rows
  // with a structural overflow (X) the drop-in replayed on each pass (verified
  // live). position:absolute removes the box from the row's flow the same way
  // for width purposes while leaving running animations untouched; no paint
  // happens between the writes, so nothing flashes.
  // left/top pin the box to its containing block's origin so its own width
  // cannot poke past the edge and read back as "structural" overflow.
  const prevPosition = host.style.position;
  const prevLeft = host.style.left;
  const prevTop = host.style.top;
  host.style.position = "absolute";
  host.style.left = "0";
  host.style.top = "0";
  const structural = overflows();
  host.style.position = prevPosition;
  host.style.left = prevLeft;
  host.style.top = prevTop;
  if (structural) return;
  compactNativeCounts(point);
}

// The row's native controls this module measures and rewrites: the one we replace plus the
// one we stand beside, deduped - an adapter can name the same element as both.
function nativeControls(point: PickerInsertionPoint): Set<HTMLElement> {
  return new Set([...elementsToArray(point.replaceElement), ...elementsToArray(point.nativeElement)]);
}

// A flex-squeezed native control whose own content no longer fits. Checked directly because
// the site can clip most of the spill, leaving the row-level scroll metric barely moved.
function nativeOverflows(point: PickerInsertionPoint): boolean {
  for (const el of nativeControls(point)) {
    if (el.isConnected && el.scrollWidth - el.clientWidth > OVERFLOW_EPSILON_PX) return true;
  }
  return false;
}

// compactNativeCountsOnOverflow gates this on a real overflow.
export function compactNativeCounts(point: PickerInsertionPoint): void {
  for (const el of nativeControls(point)) compactCounterTextIn(el);
}

// The row (or a near ancestor - the card clips, not the row itself) whose content is wider than
// its box. Scroll containers overflow by design, so an `overflow-x: auto|scroll` ancestor never
// counts.
function rowOverflows(host: HTMLElement): boolean {
  let el: HTMLElement | null = host.parentElement;
  for (let depth = 0; depth < 4 && el; depth++) {
    if (el.scrollWidth - el.clientWidth > OVERFLOW_EPSILON_PX) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== "auto" && overflowX !== "scroll") return true;
    }
    el = el.parentElement;
  }
  return false;
}

function compactCounterTextIn(root: HTMLElement): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    const parent = node.parentElement;
    if (!parent || parent.closest(OWN_NODES_SELECTOR)) continue;
    // SVG text (<title>/<desc> inside the like icon) renders no width and is the
    // control's accessible name - never a counter to rewrite.
    if (!(parent instanceof HTMLElement)) continue;
    // Only a leaf element wholly owned by the count is safe to rewrite/restore.
    if (parent.childNodes.length !== 1) continue;
    const compact = compactCountText(text) ?? compactQuotedLabelText(text);
    if (!compact) continue;
    if (!parent.hasAttribute(COUNT_ATTR)) parent.setAttribute(COUNT_ATTR, text);
    node.textContent = compact;
  }
}

// Restore the recorded original text (extension turned off). If the site re-rendered the
// counter since, the marked element is gone and there is nothing to restore. Pierces open
// shadow roots for the same reason as restoreHiddenNatives - the marked counter can live
// inside a site's shadow DOM (Reddit), invisible to a plain querySelectorAll.
export function restoreCompactedCounts(): void {
  for (const el of queryAllDeep<HTMLElement>(document, [COUNT_ATTR_SELECTOR])) {
    const original = el.getAttribute(COUNT_ATTR);
    if (original !== null) el.textContent = original;
    el.removeAttribute(COUNT_ATTR);
  }
}
