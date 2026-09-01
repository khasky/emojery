// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the content script remembers across a page's life rather than per mount: which
// route it is on, which targets have already been seen, which have already animated.
// Split out of mount-registry.ts because none of it is keyed to a LIVE mount - a target
// counted here stays counted after its picker is torn down, which is the whole point.

import type { TargetKey } from "../shared/storage";

let reportedLocationHref = "";

// Distinct pickers that became VISIBLE on the current route, behind the toolbar badge: grows
// only so the badge never ticks backward; cleared on route change and teardown. Endless feeds
// never change route, so the tally freezes at the cap. FIFO eviction (the placedTargetKeys
// trick below) is NOT available here: an evicted key re-entering the viewport would be counted
// a second time and the badge would over-report.
const SHOWN_TARGET_MAX = 10_000;
const shownTargetKeys = new Set<TargetKey>();

export function recordShownTarget(key: TargetKey): void {
  if (shownTargetKeys.size >= SHOWN_TARGET_MAX) return;
  shownTargetKeys.add(key);
}

export function shownTargetCount(): number {
  return shownTargetKeys.size;
}

// A route change clears the same set through detectRouteChange.
export function clearShownTargets(): void {
  shownTargetKeys.clear();
}

// First-placement animation gate: once a target has played its drop-in, it must
// NEVER replay this session - an SPA round-trip back to the same post re-drops
// the button otherwise. So route changes do NOT clear this set; growth is
// bounded by FIFO eviction instead (one short string per target ever animated).
const PLACED_TARGET_MAX = 2_000;
const placedTargetKeys = new Set<TargetKey>();

export function markFirstPlacement(key: TargetKey): boolean {
  if (placedTargetKeys.has(key)) return false;
  placedTargetKeys.add(key);
  if (placedTargetKeys.size > PLACED_TARGET_MAX) {
    const oldest = placedTargetKeys.values().next().value;
    if (oldest !== undefined) placedTargetKeys.delete(oldest);
  }
  return true;
}

export function clearPlacedTargets(): void {
  placedTargetKeys.clear();
}

// True the first time a scan runs under a new URL (SPA route change) - the signal to drop
// connected-but-stale mounts; also resets the visible-picker tally behind the badge.
export function detectRouteChange(): boolean {
  const href = location.href;
  if (href === reportedLocationHref) return false;
  reportedLocationHref = href;
  clearShownTargets();
  return true;
}
