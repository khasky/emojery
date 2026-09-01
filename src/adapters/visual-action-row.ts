// SPDX-License-Identifier: GPL-3.0-or-later
//
// The SHARED geometric action-row heuristic: facebook-post-row, instagram and
// threads all route through findVisualActionSlot - one regression here breaks
// three sites at once, and only e2e sweeps them. (hasRenderableBox is also
// called directly, outside the slot walk, by reddit and instagram.)

import { HIDDEN_SELECTOR, OWN_NODES_SELECTOR } from "../shared/dom";
import { safeMatches } from "./runtime";

export interface VisualActionSlot {
  row: HTMLElement;
  slot: HTMLElement;
  index: number;
  slots: HTMLElement[];
}

interface VisualActionRowOptions {
  maxDepth?: number;
  minSlots?: number;
  maxSlots?: number;
  minRowWidth?: number;
  maxRowHeight?: number;
  minSlotWidth?: number;
  minSlotHeight?: number;
  maxWidthVariance?: number;
  controlSelector?: string;
  controlPredicate?: (el: HTMLElement) => boolean;
  boundary?: (el: HTMLElement) => boolean;
}

// Wider than the same-named constant in action-labels.ts, which omits `a[href]`.
// Deliberate, not drift: slot discovery has to accept a link, because GitHub's Star IS
// an `<a href>` wrapping the counter (see github.ts); label classification must not,
// or every nav link in a row reads as an action. Keep them apart.
const DEFAULT_CONTROL_SELECTOR = 'button, [role="button"], a[href]';

export function pageHasLayout(): boolean {
  const bodyRect = document.body?.getBoundingClientRect();
  const rootRect = document.documentElement?.getBoundingClientRect();
  return !!((bodyRect && (bodyRect.width > 0 || bodyRect.height > 0)) || (rootRect && (rootRect.width > 0 || rootRect.height > 0)));
}

export function hasRenderableBox(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

// A structural root the action-row walk must not climb past: the document body,
// <html>, or <main>. Adapters extend it with their own terminal (Instagram stops
// at <article>, Threads at role="main").
export function isStructuralRoot(el: HTMLElement): boolean {
  return el === document.body || el.tagName === "HTML" || el.tagName === "MAIN";
}

function hasVisibleStyle(el: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  while (node && node !== document.documentElement) {
    const style = getComputedStyle(node);
    const opacity = style.opacity.trim();
    if (style.display === "none" || style.visibility === "hidden" || (opacity !== "" && Number(opacity) === 0)) {
      return false;
    }
    node = node.parentElement;
  }
  return true;
}

export function isRenderableInPageLayout(el: HTMLElement): boolean {
  if (!pageHasLayout() || (hasRenderableBox(el) && hasVisibleStyle(el))) return true;
  // Zero-box: a control we hid for "Hide original buttons" stays anchor-eligible,
  // or a re-scan reads it as gone and re-detects the next visible action (e.g.
  // Facebook's Comment) as slot 0, dragging the picker out of the replaced
  // control's position. native-replace.ts stamps the mark on the hidden SLOT, an
  // ancestor of the control the scan walks - hence `closest`, not a self-check.
  return el.closest(HIDDEN_SELECTOR) !== null;
}

export function findVisualActionSlot(control: HTMLElement, options: VisualActionRowOptions = {}): VisualActionSlot | null {
  // No page layout -> defer to the caller's structural fallback.
  if (!pageHasLayout()) return null;
  // The control must be renderable OR a control we collapsed for the "Hide
  // original buttons" setting. Without the latter exemption, a re-scan of a
  // recycled/rebuilt row (Instagram closing a comment modal, virtualized feeds)
  // finds the now-hidden native control, bails here, yields no candidate, and
  // the picker never re-mounts - leaving the native hidden with no Emojery
  // button. collectVisualActionSlots keeps the hidden control as a placeholder
  // so the row geometry and slot index stay correct.
  if (!isRenderableInPageLayout(control)) return null;

  const maxDepth = options.maxDepth ?? 8;
  let branch: HTMLElement | null = control;
  for (let depth = 0; depth < maxDepth && branch; depth += 1) {
    const row: HTMLElement | null = branch.parentElement;
    if (!row || options.boundary?.(row)) return null;

    const slots = collectVisualActionSlots(row, options);
    const index = slots.findIndex((item) => (item.slot === branch || item.slot.contains(branch)) && (item.control === control || item.control.contains(control)));
    if (index >= 0) {
      return {
        row,
        slot: slots[index]!.slot,
        index,
        slots: slots.map((slot) => slot.slot),
      };
    }

    branch = row;
  }
  return null;
}

function collectVisualActionSlots(row: HTMLElement, options: VisualActionRowOptions): Array<{ slot: HTMLElement; control: HTMLElement }> {
  const rowRect = row.getBoundingClientRect();
  if (rowRect.width < (options.minRowWidth ?? 0)) return [];
  if (options.maxRowHeight && rowRect.height > options.maxRowHeight) return [];

  const out: Array<{
    slot: HTMLElement;
    control: HTMLElement;
    width: number;
    hidden: boolean;
  }> = [];
  for (const child of Array.from(row.children)) {
    if (!(child instanceof HTMLElement)) continue;
    const control = findControlInSlot(child, options);
    if (!control || control.closest(OWN_NODES_SELECTOR)) continue;

    // Keep a hidden control's slot at its original index, as a placeholder exempt
    // from the size/variance filters: renumbering the row would slide a visible
    // sibling (e.g. Instagram's Comment) into slot 0 and re-anchor the picker past
    // it. Never a mount target - findVisualActionSlot's entry guard rejects it.
    if (control.closest(HIDDEN_SELECTOR)) {
      out.push({ slot: child, control, width: 0, hidden: true });
      continue;
    }
    if (!hasRenderableBox(control) || !hasVisibleStyle(control)) continue;

    const slotRect = child.getBoundingClientRect();
    const controlRect = control.getBoundingClientRect();
    const width = Math.max(slotRect.width, controlRect.width);
    const height = Math.max(slotRect.height, controlRect.height);
    if (width < (options.minSlotWidth ?? 0)) continue;
    if (height < (options.minSlotHeight ?? 0)) continue;
    out.push({ slot: child, control, width, hidden: false });
  }

  const minSlots = options.minSlots ?? 2;
  const maxSlots = options.maxSlots ?? Number.POSITIVE_INFINITY;
  if (out.length < minSlots || out.length > maxSlots) return [];

  const maxWidthVariance = options.maxWidthVariance;
  if (maxWidthVariance !== undefined) {
    const widths = out.filter((slot) => !slot.hidden).map((slot) => slot.width);
    if (widths.length > 1) {
      const widest = Math.max(...widths);
      const narrowest = Math.min(...widths);
      if (widest > 0 && (widest - narrowest) / widest > maxWidthVariance) {
        return [];
      }
    }
  }

  return out.map(({ slot, control }) => ({ slot, control }));
}

function findControlInSlot(slot: HTMLElement, options: VisualActionRowOptions): HTMLElement | null {
  const selector = options.controlSelector ?? DEFAULT_CONTROL_SELECTOR;
  const predicate = options.controlPredicate ?? ((el: HTMLElement) => safeMatches(el, selector));

  if (predicate(slot)) return slot;
  for (const el of Array.from(slot.querySelectorAll<HTMLElement>(selector))) {
    if (predicate(el)) return el;
  }
  return null;
}
