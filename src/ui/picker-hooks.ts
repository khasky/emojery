// SPDX-License-Identifier: GPL-3.0-or-later
//
// The picker popover's DOM-facing hooks - viewport math and document-level listeners - split
// out of picker.tsx so that file holds the component's state and markup. Each talks to the
// component only through the refs and setters it is handed.

import { useEffect, useLayoutEffect } from "preact/hooks";
import { LAYOUT_ATTR } from "../shared/dom";
import type { Reaction } from "../shared/reactions";
import { CATEGORIES } from "../shared/reactions";

// The emoji grid is a roving tabindex: exactly one button is Tab-reachable and the
// arrows move that one. Columns must match picker.css's grid so ArrowUp/Down land a row away.
const GRID_COLUMNS = 6;
const GRID_ITEM_SELECTOR = ".khasky-emojery-grid-item";
const SCROLL_SELECTOR = ".khasky-emojery-popover-scroll";

// WCAG 2.4.11 (focus not obscured). picker.css declares `scroll-padding` on the scroll
// container so the opaque sticky head never covers the focused cell - but the browser's
// OWN focus scrolling ignores that padding: measured in both WebKit and Firefox, arrowing
// back up left the cell 5px inside the scrollport and 67px under the head, with the
// scroll position unchanged. So correct it by hand, reading the very padding the
// stylesheet declares (picker.tsx feeds it the head's measured height), which keeps one
// source of truth for the offset and still lets an engine that honours it do the work
// first - this then finds nothing to do.
function scrollIntoPaddedView(item: HTMLElement): void {
  const scroller = item.closest<HTMLElement>(SCROLL_SELECTOR);
  if (!scroller) return;
  const style = getComputedStyle(scroller);
  const padTop = Number.parseFloat(style.scrollPaddingTop) || 0;
  const padBottom = Number.parseFloat(style.scrollPaddingBottom) || 0;
  const port = scroller.getBoundingClientRect();
  const cell = item.getBoundingClientRect();
  const hiddenAbove = port.top + padTop - cell.top;
  if (hiddenAbove > 0) {
    scroller.scrollTop -= hiddenAbove;
    return;
  }
  const hiddenBelow = cell.bottom - (port.bottom - padBottom);
  if (hiddenBelow > 0) scroller.scrollTop += hiddenBelow;
}
type GridFocusMode = "first" | "last" | "next" | "previous" | "rowNext" | "rowPrev";
// ARIA grid pattern; Home/End ignore the current item, hence the `current`-free branches below.
const GRID_KEY_MODES: Readonly<Record<string, GridFocusMode>> = { ArrowRight: "next", ArrowLeft: "previous", ArrowDown: "rowNext", ArrowUp: "rowPrev", Home: "first", End: "last" };

// Px fallbacks for the pre-measure pass only (`el.offsetWidth || POPOVER_W`): picker.css's
// `width: 18em` / `max-height: 28em` at a 16px base. Only used before the popover has laid out.
const POPOVER_W = 288;
const POPOVER_MAX_H = 448;
// Gap kept between the popover and both the trigger and the viewport edges.
const POPOVER_MARGIN = 8;
// Height (px) of the "focus band" just below the sticky header. A category nav icon fades
// from grayscale to full colour in proportion to how much of its section fills this band,
// so the colour crosses over smoothly as you scroll from one category into the next.
const CATEGORY_FOCUS_BAND = 64;

// Keyboard navigation of the emoji grid, as one unit: the roving-tabindex upkeep when the
// item set changes, the arrow/Home/End walk, and the search field's ArrowDown/ArrowUp entry
// into it. Returns the two keydown handlers the component binds; everything else is internal.
export function useGridRovingFocus({ open, itemSetKey, popRef }: { open: boolean; itemSetKey: readonly unknown[]; popRef: { current: HTMLDivElement | null } }) {
  const gridItems = (): HTMLButtonElement[] => {
    const root = popRef.current;
    return root ? Array.from(root.querySelectorAll<HTMLButtonElement>(GRID_ITEM_SELECTOR)) : [];
  };

  // Whenever the grid's item set changes (open, search, recents/popular arriving,
  // locale), ensure exactly one item is Tab-reachable.
  useEffect(() => {
    if (!open) return;
    const items = gridItems();
    const first = items[0];
    if (first && !items.some((el) => el.tabIndex === 0)) first.tabIndex = 0;
  }, [open, ...itemSetKey]);

  const focusGridItem = (mode: GridFocusMode, current?: HTMLElement) => {
    const items = gridItems();
    if (items.length === 0) return;
    const currentIndex = current ? items.indexOf(current as HTMLButtonElement) : -1;
    const nextItem = items[gridTargetIndex(mode, currentIndex, items.length)];
    if (!nextItem) return;
    for (const el of items) el.tabIndex = el === nextItem ? 0 : -1;
    nextItem.focus();
    scrollIntoPaddedView(nextItem);
  };

  const onGridItemKey = (e: KeyboardEvent) => {
    const mode = GRID_KEY_MODES[e.key];
    if (!mode) return;
    e.preventDefault();
    e.stopPropagation();
    focusGridItem(mode, e.currentTarget as HTMLElement);
  };

  const onSearchKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      focusGridItem(e.key === "ArrowDown" ? "first" : "last");
      return;
    }
    // Escape (close) and Tab (dialog focus trap) must reach the document-level handler.
    if (e.key !== "Escape" && e.key !== "Tab") e.stopPropagation();
  };

  return { onGridItemKey, onSearchKeyDown };
}

// Where each key lands, clamped at both ends (no wrap). Outside the hook so the
// index math is a plain function - the part worth asserting without a rendered grid.
export function gridTargetIndex(mode: GridFocusMode, currentIndex: number, count: number): number {
  const last = count - 1;
  switch (mode) {
    case "first":
      return 0;
    case "last":
      return last;
    case "next":
      return currentIndex >= 0 ? Math.min(currentIndex + 1, last) : 0;
    case "previous":
      return currentIndex >= 0 ? Math.max(currentIndex - 1, 0) : last;
    case "rowNext":
      return currentIndex >= 0 ? Math.min(currentIndex + GRID_COLUMNS, last) : 0;
    case "rowPrev":
      return currentIndex >= 0 ? Math.max(currentIndex - GRID_COLUMNS, 0) : last;
  }
}

// Position via `position: fixed` clamped to the viewport, measuring actual height (it
// varies with content); ResizeObserver re-runs when "Show more" expands it so the anchor
// doesn't drift.
export function usePopoverPosition({
  open,
  triggerRef,
  popRef,
  placedAboveRef,
  queryRef,
  setPopPos,
  setPlacedAbove,
  close,
}: {
  open: boolean;
  triggerRef: { current: HTMLButtonElement | null };
  popRef: { current: HTMLDivElement | null };
  placedAboveRef: { current: boolean | null };
  queryRef: { current: string };
  setPopPos: (pos: { top: number; left: number } | null) => void;
  setPlacedAbove: (above: boolean) => void;
  close: () => void;
}) {
  useLayoutEffect(() => {
    if (!open) return;
    const el = popRef.current;
    if (!el) return;
    let anchorRect: DOMRect | null = null;
    const recompute = (opts: { preserveVertical?: boolean } = {}) => {
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      if (!triggerRect) return;
      anchorRect = triggerRect;
      const popWidth = el.offsetWidth || POPOVER_W;
      const popHeight = el.offsetHeight || POPOVER_MAX_H;
      // Icon-column (reel/shorts rail) triggers sit pinned to the screen edge with the
      // native prev/next controls in the same strip; vertical placement clamps the popover
      // INTO that strip, covering the trigger and the rail controls. Open sideways into the
      // video area instead, vertically centered; prefer the side away from the screen edge.
      const shadowHost = (triggerRef.current?.getRootNode() as ShadowRoot | null)?.host;
      if (shadowHost instanceof HTMLElement && shadowHost.getAttribute(LAYOUT_ATTR) === "icon-column") {
        let sideLeft = triggerRect.left - popWidth - POPOVER_MARGIN;
        if (sideLeft < POPOVER_MARGIN) sideLeft = triggerRect.right + POPOVER_MARGIN;
        if (sideLeft >= POPOVER_MARGIN && sideLeft + popWidth <= window.innerWidth - POPOVER_MARGIN) {
          const centered = triggerRect.top + triggerRect.height / 2 - popHeight / 2;
          const sideTop = Math.min(Math.max(POPOVER_MARGIN, centered), Math.max(POPOVER_MARGIN, window.innerHeight - popHeight - POPOVER_MARGIN));
          if (!opts.preserveVertical || placedAboveRef.current == null) {
            placedAboveRef.current = false;
            setPlacedAbove(false);
          }
          setPopPos({ top: sideTop, left: sideLeft });
          return;
        }
      }
      let left = triggerRect.left;
      if (left + popWidth > window.innerWidth - POPOVER_MARGIN) {
        left = window.innerWidth - popWidth - POPOVER_MARGIN;
      }
      if (left < POPOVER_MARGIN) left = POPOVER_MARGIN;
      // Choose the side once per open (above only when the full popover clears the top),
      // then keep it while searching so a shrinking result set never flips sides.
      let above: boolean;
      if (!opts.preserveVertical || placedAboveRef.current == null) {
        above = triggerRect.top - popHeight - POPOVER_MARGIN >= POPOVER_MARGIN;
        placedAboveRef.current = above;
        setPlacedAbove(above);
      } else {
        above = placedAboveRef.current;
      }
      let top: number;
      if (above) {
        // Anchor the popover's BOTTOM to the trigger so the bottom-pinned
        // search row stays beside the button as the grid grows or shrinks.
        top = Math.max(POPOVER_MARGIN, triggerRect.top - popHeight - POPOVER_MARGIN);
      } else {
        top = triggerRect.bottom + POPOVER_MARGIN;
        if (top + popHeight > window.innerHeight - POPOVER_MARGIN) {
          top = Math.max(POPOVER_MARGIN, window.innerHeight - popHeight - POPOVER_MARGIN);
        }
      }
      setPopPos({ top, left });
    };
    recompute();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(() => {
        recompute({ preserveVertical: queryRef.current.trim().length > 0 });
      });
      ro.observe(el);
    }
    // Close on page scroll so the popover doesn't detach from a moving trigger - but not
    // for scrolls inside the popover subtree, and not for movement-free scrolls: at
    // fractional OS scaling (125%) a scroll-snap container can settle on a sub-pixel
    // offset right after opening (FB reels in Firefox), insta-closing the popover.
    const onScroll = (e: Event) => {
      const target = e.target as Node | null;
      if (target && el.contains(target)) return;
      const triggerRect = triggerRef.current?.getBoundingClientRect();
      if (triggerRect && anchorRect && Math.abs(triggerRect.top - anchorRect.top) < 1 && Math.abs(triggerRect.left - anchorRect.left) < 1) return;
      close();
    };
    const onResize = () => recompute();
    // Passive: the handler only reads a rect and closes, never preventDefault - without
    // the flag the browser must wait for it before scrolling every frame the popover is open.
    window.addEventListener("scroll", onScroll, { capture: true, passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      ro?.disconnect();
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [open]);
}

// Three jobs on one `open` gate and one listener pair: capture-phase outside-click dismiss,
// Escape dismiss with focus restored to the trigger, and the Tab trap that keeps focus inside
// the dialog.
export function usePopoverDismiss({ open, triggerRef, popRef, close }: { open: boolean; triggerRef: { current: HTMLButtonElement | null }; popRef: { current: HTMLDivElement | null }; close: () => void }) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const path = e.composedPath();
      if (triggerRef.current && path.includes(triggerRef.current)) return;
      if (popRef.current && path.includes(popRef.current)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        close();
        triggerRef.current?.focus();
        return;
      }
      // Trap Tab within the role="dialog" popover so focus can't land on page content
      // behind an open popover. composedPath()[0] is the real focused node even across
      // the shadow boundary (document-level `e.target` would be retargeted to the host).
      // Grid emojis parked at tabindex="-1" (roving tabindex) must not count as stops.
      if (e.key === "Tab") {
        const pop = popRef.current;
        if (!pop) return;
        const focusable = Array.from(pop.querySelectorAll<HTMLElement>('a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter((el) => el.offsetParent !== null);
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        const current = e.composedPath()[0] as HTMLElement;
        if (e.shiftKey && (current === first || !pop.contains(current))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && current === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
}

// Category nav scroll-spy: score each category by how much of its section fills the focus band
// under the sticky header, stored as its nav icon's colour intensity. rAF-throttled; re-runs
// when content above the grid changes height.
export function useCategoryScrollSpy({
  open,
  query,
  recentLength,
  total,
  mine,
  breakdownDisplayLimit,
  placedAbove,
  scrollRef,
  stickyHeadRef,
  setCategoryColor,
}: {
  open: boolean;
  query: string;
  recentLength: number;
  total: number;
  mine: Reaction | null;
  breakdownDisplayLimit: number;
  placedAbove: boolean;
  scrollRef: { current: HTMLDivElement | null };
  stickyHeadRef: { current: HTMLDivElement | null };
  setCategoryColor: (next: number[]) => void;
}) {
  useEffect(() => {
    if (!open || query.trim()) return;
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    let raf = 0;
    const compute = () => {
      raf = 0;
      const sections = scrollEl.querySelectorAll<HTMLElement>("[data-khasky-emojery-cat]");
      if (sections.length === 0) return;
      const scRect = scrollEl.getBoundingClientRect();
      const headH = stickyHeadRef.current?.offsetHeight ?? 0;
      // The nav bar sits at the top when the popover opens below the trigger, at the bottom
      // when above; score the focus band just inside the grid on the nav's side either way.
      const bandTop = placedAbove ? scRect.bottom - headH - CATEGORY_FOCUS_BAND : scRect.top + headH;
      const bandBottom = bandTop + CATEGORY_FOCUS_BAND;
      const next = CATEGORIES.map(() => 0);
      sections.forEach((sec) => {
        const idx = Number(sec.dataset.khaskyEmojeryCat);
        if (!Number.isInteger(idx) || idx < 0 || idx >= next.length) return;
        const sectionRect = sec.getBoundingClientRect();
        const overlap = Math.min(sectionRect.bottom, bandBottom) - Math.max(sectionRect.top, bandTop);
        next[idx] = Math.max(0, Math.min(1, overlap / CATEGORY_FOCUS_BAND));
      });
      setCategoryColor(next);
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(compute);
    };
    compute();
    scrollEl.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scrollEl.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
    // `recentLength`/`total`/`mine` gate the sections above the grid and
    // `breakdownDisplayLimit` their height - all shift section positions, so recompute
    // when any of them change.
  }, [open, query, recentLength, total, mine, breakdownDisplayLimit, placedAbove]);
}
