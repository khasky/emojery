// SPDX-License-Identifier: GPL-3.0-or-later
//
// Deferred mounts: the record of what is waiting, and the ONE IntersectionObserver that
// decides when it stops waiting. mount-registry.ts owns only LIVE mounts - the two
// states never overlap, and keeping the pending half here keeps the map private behind
// the accessors below.
//
// The invariant the whole module exists for: an entry may never leave `pendingMounts`
// without its anchor being unobserved first, or the shared observer keeps a strong
// reference to a dead element for the life of the tab. Every removal path routes through
// `cancelPendingMount`.

import type { PickerInsertionPoint } from "../shared/adapter";
import type { TargetKey } from "../shared/storage";

const pendingMounts = new Map<TargetKey, { point: PickerInsertionPoint }>();

export function pendingMountPoint(key: TargetKey): PickerInsertionPoint | undefined {
  return pendingMounts.get(key)?.point;
}

/** Records or re-points a deferred mount. Re-pointing MUTATES the existing record
 *  rather than replacing it, so a `cancelPendingMount` racing this still sees one
 *  entry to unobserve. */
export function setPendingMount(key: TargetKey, point: PickerInsertionPoint): void {
  const pending = pendingMounts.get(key);
  if (pending) pending.point = point;
  else pendingMounts.set(key, { point });
}

// How far ahead of the viewport a deferred mount fires - the observer's rootMargin
// below and the synchronous probe next to it, so a scan cannot mount eagerly on an
// anchor this observer is still waiting on and double-mount it.
const MOUNT_PREFETCH_MARGIN_PX = 200;

// The synchronous half of that margin: is this element already inside the band the
// observer would fire on? Callers use it to skip the deferral entirely.
export function isNearPrefetchMargin(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return false;
  const width = window.innerWidth || document.documentElement.clientWidth;
  const height = window.innerHeight || document.documentElement.clientHeight;
  const margin = MOUNT_PREFETCH_MARGIN_PX;
  return rect.bottom >= -margin && rect.right >= -margin && rect.top <= height + margin && rect.left <= width + margin;
}

// ONE IntersectionObserver for every deferred mount (it used to be one instance
// per pending anchor - dozens on a feed, each strongly referencing its anchor).
let pendingVisibility: IntersectionObserver | null = null;
let pendingVisibleHandler: ((key: TargetKey) => void) | null = null;
const pendingAnchorByKey = new Map<TargetKey, Element>();
const pendingKeyByAnchor = new Map<Element, TargetKey>();

// Registered once by the mount layer, which owns what "this anchor is in range"
// means. Kept out of observePendingAnchor's signature: the observer is a single
// shared instance, so a per-call handler could only ever be the same one.
export function setPendingAnchorHandler(onVisible: (key: TargetKey) => void): void {
  pendingVisibleHandler = onVisible;
}

export function observePendingAnchor(key: TargetKey, anchor: Element): void {
  if (typeof IntersectionObserver === "undefined") {
    // No deferral possible: treat the anchor as visible now.
    pendingVisibleHandler?.(key);
    return;
  }
  pendingVisibility ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const key = pendingKeyByAnchor.get(entry.target);
        if (key === undefined) continue;
        unobservePendingAnchor(key);
        pendingVisibleHandler?.(key);
      }
    },
    { rootMargin: `${MOUNT_PREFETCH_MARGIN_PX}px 0px` },
  );
  unobservePendingAnchor(key);
  pendingAnchorByKey.set(key, anchor);
  pendingKeyByAnchor.set(anchor, key);
  pendingVisibility.observe(anchor);
}

function unobservePendingAnchor(key: TargetKey): void {
  const anchor = pendingAnchorByKey.get(key);
  if (!anchor) return;
  pendingAnchorByKey.delete(key);
  if (pendingKeyByAnchor.get(anchor) === key) pendingKeyByAnchor.delete(anchor);
  pendingVisibility?.unobserve(anchor);
}

/** Re-point an EXISTING observation at a new anchor; a no-op for a key that is not
 *  observed yet. That distinction lives here rather than at the call site: a fresh
 *  pending mount is still awaiting its settings read and gets observed after it, so
 *  observing here would start watching an anchor the settings gate may still drop. */
export function reobservePendingAnchor(key: TargetKey, anchor: Element): void {
  if (pendingAnchorByKey.has(key)) observePendingAnchor(key, anchor);
}

/** The ONE way a deferred mount is given up: unobserve the anchor, then forget the
 *  entry. Deleting from `pendingMounts` alone leaves the shared observer holding a
 *  strong reference to a dead anchor. Safe on a key that was never observed -
 *  `unobservePendingAnchor` is a no-op then - so every drop path can route here. */
export function cancelPendingMount(key: TargetKey): void {
  unobservePendingAnchor(key);
  pendingMounts.delete(key);
}

/** Deleting from a Map while iterating it is well-defined in JS, so the sweeps below
 *  iterate the live map instead of copying it first. */
export function cancelDisconnectedPendingMounts(): void {
  for (const [key, pending] of pendingMounts) {
    if (pending.point.anchor.isConnected) continue;
    cancelPendingMount(key);
  }
}

/** Route changed: a deferred mount the fresh scan no longer produces is stale, however
 *  live its anchor still looks. The scan is the authority on what may stay. */
export function cancelPendingMountsOutside(activeKeys: ReadonlySet<TargetKey>): void {
  for (const key of pendingMounts.keys()) {
    if (activeKeys.has(key)) continue;
    cancelPendingMount(key);
  }
}

export function cancelAllPendingMounts(): void {
  for (const key of pendingMounts.keys()) {
    cancelPendingMount(key);
  }
}

/** A stale key still holding the anchor a fresh point wants: drop it so the two
 *  cannot both believe they own the slot. Only when it is the SAME anchor - a
 *  pending mount elsewhere on the page is none of this point's business. */
export function cancelPendingMountOnAnchor(key: TargetKey, anchor: HTMLElement): void {
  if (pendingMounts.get(key)?.point.anchor === anchor) cancelPendingMount(key);
}

/** Test seam. The shared observer and its anchor maps are deliberately left standing,
 *  the same way resetMountRegistryForTests leaves the rest of the module state. */
export function clearPendingMountsForTests(): void {
  pendingMounts.clear();
}
