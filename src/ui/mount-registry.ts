// SPDX-License-Identifier: GPL-3.0-or-later
//
// LIVE mounts: the per-key registries a rendered picker occupies, and the DOM
// bookkeeping around its node. The two neighbours it delegates to are
// `mount-anchors.ts` (deferred mounts, the opposite state) and `mount-session.ts`
// (what outlives a mount: the route, the shown and placed tallies).
import { render } from "preact";
import type { PickerInsertionPoint } from "../shared/adapter";
import { HOST_CLASS, HOST_SELECTOR, MOUNT_ATTR } from "../shared/dom";
import type { VoteBroadcast } from "../shared/messages";
import type { Reaction, TargetCounts } from "../shared/reactions";
import { type TargetKey, targetKey } from "../shared/storage";
import { cancelAllPendingMounts, cancelDisconnectedPendingMounts, cancelPendingMountOnAnchor, cancelPendingMountsOutside, clearPendingMountsForTests } from "./mount-anchors";
import { clearPlacedTargets, clearShownTargets } from "./mount-session";
import { forgetRingHost, pruneRingHosts } from "./ring-spin";
import { forgetThemedHost, pruneThemedHosts } from "./themed-hosts";

// One LIVE mount = an entry in mountedTargets + mountedAnchors + the listener/callback maps,
// all keyed by TargetKey; only dropMount(key) removes them together, which is why those are
// module-private.
const mountedTargets = new Map<TargetKey, Node>();
const mountedAnchors = new Map<TargetKey, HTMLElement>();

// Timers scheduled for a host's post-mount style reblends; cleared when the
// mount node is removed so a torn-down feed card doesn't keep forcing layout.
const hostTimers = new WeakMap<HTMLElement, number[]>();

export function trackHostTimer(host: HTMLElement, id: number): void {
  const list = hostTimers.get(host);
  if (list) list.push(id);
  else hostTimers.set(host, [id]);
}

function clearHostTimers(host: HTMLElement): void {
  const list = hostTimers.get(host);
  if (!list) return;
  hostTimers.delete(host);
  for (const id of list) window.clearTimeout(id);
}

/** How a mounted picker takes a counts update. `value` is optional: the sign-out
 *  path strips the per-user "mine" marker without touching the community counts. */
export type RefreshCallback = (next: { value?: TargetCounts; myReaction: Reaction | null; authed?: boolean }) => void;

const voteListeners = new Map<TargetKey, (b: VoteBroadcast) => void>();
const refreshCallbacks = new Map<TargetKey, RefreshCallback>();
const refreshTargets = new Map<TargetKey, PickerInsertionPoint["target"]>();

export function mountedNode(key: TargetKey): Node | undefined {
  return mountedTargets.get(key);
}

/** Test seam: how many mounts the registry holds; no production caller. */
export function mountedCount(): number {
  return mountedTargets.size;
}

/** Record the node just inserted for `key`. The rest of the mount's entries are
 *  registered as the render reaches them (subscribeMount /
 *  setRefreshCallback); `dropMount` clears all of them together. */
export function registerMountNode(key: TargetKey, node: Node): void {
  mountedTargets.set(key, node);
}

// What a rendering mount subscribes in one step: the broadcast listener and the
// target its auth-change refetch needs. Registered together because a mount with
// one and not the other either misses another tab's votes or is skipped by
// authRefreshEntries.
export function subscribeMount(key: TargetKey, target: PickerInsertionPoint["target"], onVote: (b: VoteBroadcast) => void): void {
  setVoteListener(key, onVote);
  refreshTargets.set(key, target);
}

/** Half of `subscribeMount`, exported for the suites that register a listener without a
 *  target; no production caller reaches past `subscribeMount`. */
export function setVoteListener(key: TargetKey, listener: (b: VoteBroadcast) => void): void {
  voteListeners.set(key, listener);
}

export function setRefreshCallback(key: TargetKey, cb: RefreshCallback): void {
  refreshCallbacks.set(key, cb);
}

/** Push a counts update into a mounted picker. False when that key has no
 *  callback yet - the caller decides whether to retry (see hydrateDeferredCounts). */
export function applyRefresh(key: TargetKey, next: Parameters<RefreshCallback>[0]): boolean {
  const cb = refreshCallbacks.get(key);
  if (!cb) return false;
  cb(next);
  return true;
}

/** Every mount that can be refetched on an auth change, callback paired with its
 *  target. A callback whose target is already gone is skipped, not reported. */
export function authRefreshEntries(): Array<{ cb: RefreshCallback; target: PickerInsertionPoint["target"] }> {
  const out: Array<{ cb: RefreshCallback; target: PickerInsertionPoint["target"] }> = [];
  for (const [key, cb] of refreshCallbacks) {
    const target = refreshTargets.get(key);
    if (target) out.push({ cb, target });
  }
  return out;
}

export function forEachMountedHost(fn: (host: HTMLElement) => void): void {
  for (const node of mountedTargets.values()) {
    const host = hostElementOfMount(node);
    if (host?.isConnected) fn(host);
  }
}

export function dispatchVoteSync(b: VoteBroadcast): void {
  const fn = voteListeners.get(targetKey(b.target));
  if (fn) fn(b);
}

/** Test seam: the registries below are module state and outlive a single test's setup.
 *  Only the per-key registries are cleared - every other piece of module state is
 *  deliberately left standing (the shared pending-anchor observer and its maps, the shown
 *  and placed target sets, the last reported route href, the prune clock). */
export function resetMountRegistryForTests(): void {
  mountedTargets.clear();
  mountedAnchors.clear();
  clearPendingMountsForTests();
  voteListeners.clear();
  refreshCallbacks.clear();
  refreshTargets.clear();
}

// Deleting from a Map/Set while iterating it is well-defined in JS, so these
// loops iterate the live collections instead of copying each one first.
export function pruneDisconnected(): void {
  // Iterating `mountedTargets` - the collection a mount enters FIRST, at
  // insertion. Walking a "finished rendering" set instead left a node that was
  // inserted but never finished its render invisible here forever.
  for (const [key, node] of mountedTargets) {
    if (node.isConnected) continue;
    destroyMount(key, node);
  }
  cancelDisconnectedPendingMounts();
  pruneThemedHosts();
  pruneRingHosts();
}

export function reconcileScanMounts(points: PickerInsertionPoint[], opts: { removeConnectedStale: boolean }): void {
  pruneDisconnected();
  if (!opts.removeConnectedStale) return;

  // Route changed: a mount the fresh scan no longer produces is stale even while
  // its node is still connected - the new route's scan is the authority on what
  // may stay. Keeping connected-stale mounts here left a trigger mounted while a
  // post's own detail page rejected its row (verified live on Threads: the
  // parent-context post kept the trigger the `/media` viewer legitimately
  // mounted, after the viewer closed onto a reply's page). A wrongly removed
  // mount costs one remount on the next scan; a wrongly kept one stays wrong
  // until reload.
  const activeKeys = new Set(points.map((point) => targetKey(point.target)));
  for (const [key, node] of mountedTargets) {
    if (activeKeys.has(key)) continue;
    destroyMount(key, node);
  }
  cancelPendingMountsOutside(activeKeys);
}

// The ONE way a mounted node leaves the DOM. Unmounting the preact tree first is what runs
// the Picker's effect cleanups: a node dropped while its popover was open would otherwise
// leave that popover's capture-phase `scroll` + `mousedown` document listeners and its
// ResizeObserver installed for the life of the tab - one leaked set per recycled feed card,
// on the hottest event a feed has.
export function removeMountNode(node: Node): void {
  const host = hostElementOfMount(node);
  if (host) {
    if (host.shadowRoot) render(null, host.shadowRoot);
    // IntersectionObserver keeps a strong reference to what it observes.
    forgetRingHost(host);
    forgetThemedHost(host);
    clearHostTimers(host);
  }
  node.parentNode?.removeChild(node);
}

// The trigger host inside a mounted node (the host itself, or wrapped in an adapter wrapper).
export function hostElementOfMount(node: Node): HTMLElement | null {
  if (!(node instanceof HTMLElement)) return null;
  return node.classList.contains(HOST_CLASS) ? node : node.querySelector<HTMLElement>(HOST_SELECTOR);
}

export function claimMountAnchor(anchor: HTMLElement, key: TargetKey): void {
  const prev = mountedAnchors.get(key);
  if (prev && prev !== anchor && prev.getAttribute(MOUNT_ATTR) === key) {
    prev.removeAttribute(MOUNT_ATTR);
  }
  anchor.setAttribute(MOUNT_ATTR, key);
  mountedAnchors.set(key, anchor);
}

/** Forget everything a mount registered under `key`, in one step - deleting from a single
 *  collection strands the listener, the refresh callback or the anchor's `MOUNT_ATTR` claim,
 *  and a stale callback keeps taking broadcasts for a picker that is gone. Does NOT touch the
 *  DOM and does not unmount the picker - every caller that has the node pairs it with
 *  `removeMountNode` through `destroyMount` below, detached node included. Exported only
 *  for the suites that assert the registry half on its own. */
export function dropMount(key: TargetKey): void {
  mountedTargets.delete(key);
  voteListeners.delete(key);
  refreshCallbacks.delete(key);
  refreshTargets.delete(key);
  const anchor = mountedAnchors.get(key);
  if (anchor) {
    if (anchor.getAttribute(MOUNT_ATTR) === key) anchor.removeAttribute(MOUNT_ATTR);
    mountedAnchors.delete(key);
  }
}

/** The paired teardown of a mount: `removeMountNode` + `dropMount`. Calling only one half is
 *  the bug both halves exist to prevent - a stranded listener, or a node left in the page with
 *  nothing tracking it. Use it for a node the SITE already detached too (a virtualized feed
 *  card): `removeMountNode` is a no-op on the DOM side there but still unmounts the preact tree. */
export function destroyMount(key: TargetKey, node: Node): void {
  removeMountNode(node);
  dropMount(key);
}

export function teardownAllMounts(): void {
  for (const [key, node] of mountedTargets) {
    destroyMount(key, node);
  }
  cancelAllPendingMounts();
  // The shared overlay host is registered themed outside the mount registry, so it needs the
  // sweep. No pruneRingHosts() to match: every node above went through removeMountNode, which
  // already released its ring host.
  pruneThemedHosts();
  clearPlacedTargets();
  clearShownTargets();
}

export function clearStaleAnchorMount(point: PickerInsertionPoint, key: TargetKey): void {
  // The attribute was written by claimMountAnchor from a targetKey(), so reading it
  // back is the one place a raw string legitimately becomes a TargetKey again.
  const staleKey = point.anchor.getAttribute(MOUNT_ATTR) as TargetKey | null;
  if (!staleKey || staleKey === key) return;

  cancelPendingMountOnAnchor(staleKey, point.anchor);

  const mounted = mountedTargets.get(staleKey);
  if (!mounted) return;
  if (!mounted.isConnected) {
    destroyMount(staleKey, mounted);
    return;
  }
  if (isMountNodeForPoint(mounted, point)) {
    destroyMount(staleKey, mounted);
  }
}

function isMountNodeForPoint(node: Node, point: PickerInsertionPoint): boolean {
  switch (point.position) {
    case "before":
      return point.anchor.previousSibling === node;
    case "after":
      return point.anchor.nextSibling === node;
    case "append":
      return node.parentNode === point.anchor;
  }
}

export function isCurrentMountPoint(point: PickerInsertionPoint, key: TargetKey): boolean {
  return point.anchor.isConnected && point.anchor.getAttribute(MOUNT_ATTR) === key;
}

export function clearAdjacentMountNodes(point: PickerInsertionPoint, keep?: Node): void {
  for (const node of adjacentMountNodes(point)) {
    if (node === keep) continue;
    removeMountNode(node);
  }
}

function adjacentMountNodes(point: PickerInsertionPoint): Node[] {
  switch (point.position) {
    case "before":
      return adjacentSiblings(point.anchor.previousSibling, "previousSibling");
    case "after":
      return adjacentSiblings(point.anchor.nextSibling, "nextSibling");
    case "append":
      return Array.from(point.anchor.childNodes).filter(isMountNode);
  }
}

// `direction` is a literal union and the walk only reads DOM siblings - hence the
// two suppressions of semgrep's prototype-pollution loop heuristic below.
function adjacentSiblings(start: ChildNode | null, direction: "previousSibling" | "nextSibling"): Node[] {
  const out: Node[] = [];
  let node: ChildNode | null = start;
  while (node) {
    if (isIgnorableTextNode(node)) {
      // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
      node = node[direction];
      continue;
    }
    if (!isMountNode(node)) break;
    out.push(node);
    // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
    node = node[direction];
  }
  return out;
}

function isIgnorableTextNode(node: Node): boolean {
  return node.nodeType === Node.TEXT_NODE && !node.textContent?.trim();
}

function isMountNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false;
  if (node.classList.contains(HOST_CLASS)) return true;
  for (const child of Array.from(node.children)) {
    if (child instanceof HTMLElement && child.classList.contains(HOST_CLASS)) {
      return true;
    }
  }
  return false;
}

// The wrapper spec a mount was built with, stamped verbatim (see wrapHost below).
// Compared as the RAW spec string - the browser-normalized style.cssText formats
// differently and would flag a phantom change on every scan (a permanent remount loop).
// The mark and its key are written and read inside this module; both are exported so the
// suites can assert the stamp without reaching into a rendered mount.
export const WRAPPER_SPEC_ATTR = "data-khasky-emojery-wrapper-spec";

export function wrapperSpecKey(wrapper: NonNullable<PickerInsertionPoint["wrapper"]>): string {
  return [wrapper.tagName, wrapper.className ?? "", wrapper.style ?? ""].join("|");
}

// Builds the node that actually gets inserted: the bare host, or the adapter's
// wrapper around it carrying the verbatim spec stamp wrapperSpecChanged reads back.
// Lives here, next to that stamp, so the two cannot drift.
//
// The wrapper gets EXACTLY ONE child. mount-style's isOwnMountNode is the one "is this
// our node" predicate that relies on it; give a wrapper a second child and it stops
// agreeing with hostElementOfMount / isMountNode here - see the note on isOwnMountNode.
export function wrapHost(host: HTMLElement, wrapper: PickerInsertionPoint["wrapper"]): Node {
  if (!wrapper) return host;
  const el = document.createElement(wrapper.tagName);
  if (wrapper.className) el.className = wrapper.className;
  if (wrapper.style) el.style.cssText = wrapper.style;
  el.setAttribute(WRAPPER_SPEC_ATTR, wrapperSpecKey(wrapper));
  el.appendChild(host);
  return el;
}

// A route change can move the SAME target onto a surface whose binding declares a
// different wrapper (X status row <-> its photo-view row); moving the old node would carry
// the old wrapper's flex/margins and mis-space the trigger, so the caller rebuilds instead.
export function wrapperSpecChanged(mounted: Node, point: PickerInsertionPoint): boolean {
  const isBareHost = mounted instanceof HTMLElement && mounted.classList.contains(HOST_CLASS);
  if (!point.wrapper) return !isBareHost;
  if (!(mounted instanceof HTMLElement) || isBareHost) return true;
  return mounted.getAttribute(WRAPPER_SPEC_ATTR) !== wrapperSpecKey(point.wrapper);
}

// The whole reuse step for a live mount: claim the new anchor, move the node into
// its slot, and clear any stale sibling mount left behind. One call because doing
// two of the three leaves the registry and the DOM disagreeing about the slot.
export function reuseMountNode(mounted: Node, point: PickerInsertionPoint, key: TargetKey): void {
  claimMountAnchor(point.anchor, key);
  moveMountNode(mounted, point);
  clearAdjacentMountNodes(point, mounted);
}

// The DOM half of `reuseMountNode`, its only production caller; exported so the suites can
// assert the move without also claiming the anchor.
export function moveMountNode(node: Node, point: PickerInsertionPoint): void {
  switch (point.position) {
    case "before":
      if (point.anchor.previousSibling !== node) {
        point.anchor.parentNode?.insertBefore(node, point.anchor);
      }
      break;
    case "after":
      if (point.anchor.nextSibling !== node) {
        point.anchor.parentNode?.insertBefore(node, point.anchor.nextSibling);
      }
      break;
    case "append":
      if (node.parentNode !== point.anchor) {
        point.anchor.appendChild(node);
      }
      break;
  }
}
