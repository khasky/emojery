// SPDX-License-Identifier: GPL-3.0-or-later
//
// Counts loading for a mounted trigger: the initial cache/local read, the
// deferred server hydration applied through the picker's refresh callback, and
// the per-target auth-change refetch. Apart from mount.ts (the mount lifecycle):
// these own only count resolution and the message round-trips they need.

import type { PickerInsertionPoint } from "../shared/adapter";
import type { RuntimeResponse } from "../shared/messages";
import type { Reaction, TargetCounts } from "../shared/reactions";
import { DEFAULT_BREAKDOWN_LIMIT } from "../shared/reactions";
import { type CachedTarget, getCachedCounts, getOwnReaction, type TargetKey, targetKey } from "../shared/storage";
import { maybePlayPublicReactionIntro } from "./animations";
import { sendMessage } from "./messaging";
import { applyRefresh, type RefreshCallback } from "./mount-registry";

// The community-aggregate half of a TargetCounts (everything except the per-user
// `myReaction`), copied so callers thread the user's own reaction in separately.
type AggregateCounts = Pick<TargetCounts, "counts" | "total" | "loaded" | "hasMore">;
export function pickAggregateCounts(src: AggregateCounts): AggregateCounts {
  return { counts: src.counts, total: src.total, loaded: src.loaded, hasMore: src.hasMore };
}

// One mounted picker's reaction to an auth change. The caller runs these through a bounded
// concurrency pool (mount.ts AUTH_REFRESH_CONCURRENCY) and resolves `nowAuthed` once for all
// of them, not per target.
export async function refreshTarget(cb: RefreshCallback, target: PickerInsertionPoint["target"], nowAuthed: boolean): Promise<void> {
  if (!nowAuthed) {
    // Sign-out doesn't change the community aggregate, so only the per-user "mine"
    // marker is stripped. A refetch here would also risk replacing the up-to-date
    // optimistic counts with an older cached snapshot, resurrecting long-gone reactions.
    cb({ myReaction: null, authed: false });
    return;
  }
  const fresh = (await sendMessage({ type: "fetchCount", target, limit: DEFAULT_BREAKDOWN_LIMIT }).catch(() => null)) as RuntimeResponse | null;
  if (fresh?.type !== "count") return;
  const serverCounts = fresh.data;
  cb({
    value: pickAggregateCounts(serverCounts),
    myReaction: serverCounts.myReaction ?? null,
    authed: true,
  });
}

// How long a scan's prime stays valid for late mounts.
const COUNTS_PRIME_TTL_MS = 5_000;

let countsPrime: { at: number; keys: Set<TargetKey>; hits: Promise<Record<string, CachedTarget>> } | null = null;

// One multi-key read per scan, shared by every mount in it, instead of a single-key storage
// round-trip per trigger. A point that mounts after the prime falls through to its own read -
// an optimization, never the truth.
export function primeCachedCounts(targets: PickerInsertionPoint["target"][]): void {
  if (targets.length === 0) return;
  countsPrime = {
    at: Date.now(),
    keys: new Set(targets.map(targetKey)),
    hits: getCachedCounts(targets)
      .then((read) => read.hits)
      .catch((): Record<string, CachedTarget> => ({})),
  };
}

/** Test seam: the prime is module state and outlives a test's stubbed reads. */
export function clearCachedCountsPrime(): void {
  countsPrime = null;
}

async function readCachedCounts(target: PickerInsertionPoint["target"]): Promise<CachedTarget | undefined> {
  const key = targetKey(target);
  const prime = countsPrime;
  if (prime?.keys.has(key) && Date.now() - prime.at < COUNTS_PRIME_TTL_MS) {
    return (await prime.hits)[key];
  }
  // An unreadable cache is a miss, not a failed mount.
  const hits = await getCachedCounts([target])
    .then((read) => read.hits)
    .catch((): Record<string, CachedTarget> => ({}));
  return hits[key];
}

export async function loadInitial(
  point: PickerInsertionPoint,
  auth: { authed: boolean; userId: string | null },
): Promise<{
  value: TargetCounts;
  myReaction: Reaction | null;
  isLoading: boolean;
}> {
  // `own` - the user's own reaction, a durable local fact: it fills a null own-reaction
  // from the (TTL-expiring) cache or a lagging server read, so a re-mount can't drop it -
  // a definite cached value still wins. Scoped to the signed-in account, skipped when
  // signed out. `cached` - an unreadable cache is a miss, not a failed mount: the trigger
  // renders its empty state and the deferred server fetch below fills the counts in.
  //
  // Both storage reads go out together: neither feeds the other, and the trigger's shadow
  // root stays empty until the slower one lands.
  const userId = auth.authed ? auth.userId : null;
  const [own, cached] = await Promise.all([userId ? getOwnReaction(point.target, userId).catch(() => null) : null, readCachedCounts(point.target)]);
  if (cached) {
    return {
      value: pickAggregateCounts(cached),
      myReaction: cached.myReaction ?? own,
      isLoading: false,
    };
  }
  // Cache miss: local reads only. The server fetch is deferred past the first render (see
  // doMount) - awaiting it here held the WHOLE trigger invisible for a network round-trip
  // per post, with the native Like already hidden in replace mode (the Facebook "slow
  // rendering" bug); the counter fills in when the fetch lands.
  return {
    value: { counts: {}, total: 0, loaded: 0, hasMore: false },
    myReaction: own,
    isLoading: true,
  };
}

// Retry window for a refresh callback registered after the fetch resolves.
const REFRESH_CB_RETRY_MS = 50;

// The deferred half of loadInitial: one server count fetch, applied through the
// picker's refresh callback so the already-visible trigger hydrates in place.
// A failed fetch needs no refresh - the trigger already shows the empty state.
export async function hydrateDeferredCounts(point: PickerInsertionPoint, key: TargetKey, fallbackMine: Reaction | null, authed: boolean, animations: boolean): Promise<void> {
  const fresh = (await sendMessage({
    type: "fetchCount",
    target: point.target,
    limit: DEFAULT_BREAKDOWN_LIMIT,
  }).catch(() => null)) as RuntimeResponse | null;
  if (fresh?.type !== "count") return;
  const serverCounts = fresh.data;
  const next = { value: pickAggregateCounts(serverCounts), myReaction: serverCounts.myReaction ?? fallbackMine, authed };
  const apply = () => applyRefresh(key, next);
  // The picker registers its refresh callback in a post-paint effect; a fetch
  // served from the background's memory can resolve before that, so `apply`
  // finds no callback. One short retry closes the gap (a no-op if the mount was
  // torn down meanwhile).
  if (!apply()) window.setTimeout(apply, REFRESH_CB_RETRY_MS);
  if (animations) maybePlayPublicReactionIntro(next.value);
}
