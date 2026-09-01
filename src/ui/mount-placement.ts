// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which of an insertion point's two declared placements is live, and whether a
// mounted host is still on that one. Kept out of mount.ts so it is MEASURED:
// mount.ts is excluded from coverage wholesale (its live-page orchestration is
// e2e's to cover), and at file granularity that exclusion swallowed this
// struct-level decision logic too - the part that needs nothing but a
// PickerInsertionPoint and a generic element.
import type { PickerInsertionPoint } from "../shared/adapter";
import { PLACEMENT_ATTR } from "../shared/dom";
import { hostElementOfMount } from "./mount-registry";

// Uses `offsetParent` rather than client rects so a zero-size but displayed wrapper
// (e.g. GitHub's `display:inline` `ul.pagehead-actions`, whose list-item children still
// render) counts as visible; a `display:none` element has a null `offsetParent`.
export function isRendered(el: HTMLElement): boolean {
  return el.isConnected && (el.offsetParent !== null || getComputedStyle(el).position === "fixed");
}

// The element the trigger is inserted into for a placement: the anchor's parent
// for a sibling insert, the anchor itself for an append. Its visibility - not the
// anchor's - decides the fallback, so hiding just the native anchor (the
// "Hide original buttons" setting) does not trigger a relocation; only the
// whole container going `display:none` (a responsive breakpoint) does.
export function insertionContainer(anchor: HTMLElement, position: PickerInsertionPoint["position"]): HTMLElement | null {
  return position === "append" ? anchor : anchor.parentElement;
}

// A placement is "on its fallback" when its active anchor is the fallback anchor.
export function isFallbackPlacement(point: PickerInsertionPoint): boolean {
  return !!point.fallback && point.anchor === point.fallback.anchor;
}

// Keep the primary placement while its insertion container is rendered; swap to the declared
// `fallback` only when the primary container is hidden and the fallback's is itself rendered.
// Returns the input unchanged otherwise, so ordinary placements are untouched.
export function resolveResponsivePlacement(point: PickerInsertionPoint): PickerInsertionPoint {
  const fb = point.fallback;
  if (!fb) return point;
  const primaryContainer = insertionContainer(point.anchor, point.position);
  if (!primaryContainer || isRendered(primaryContainer)) return point;
  const fbContainer = insertionContainer(fb.anchor, fb.position);
  if (!fbContainer || !isRendered(fbContainer)) return point;
  const swapped: PickerInsertionPoint = {
    ...point,
    anchor: fb.anchor,
    position: fb.position,
  };
  if (fb.wrapper) swapped.wrapper = fb.wrapper;
  else delete swapped.wrapper;
  if (fb.triggerLayout) swapped.triggerLayout = fb.triggerLayout;
  else delete swapped.triggerLayout;
  return swapped;
}

// True when a mounted host's recorded placement mode (primary/fallback) no longer
// matches the mode the current scan wants - the signal to re-mount rather than
// move a wrapped node into the other context.
export function placementModeChanged(mounted: Node, point: PickerInsertionPoint): boolean {
  const host = hostElementOfMount(mounted);
  if (!host) return false;
  const wasFallback = host.getAttribute(PLACEMENT_ATTR) === "fallback";
  return wasFallback !== isFallbackPlacement(point);
}
