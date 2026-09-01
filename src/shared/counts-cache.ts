// SPDX-License-Identifier: GPL-3.0-or-later
//
// The `cache:`-prefixed read-through cache of per-target reaction counts.

import type { TargetRef } from "./adapter";
import { READ_CACHE_TTL_MS } from "./config";
import { applyCountsDelta, applyTotalDelta } from "./reaction-delta";
import type { Reaction, TargetCounts } from "./reactions";
import { setOwnReaction, targetKey } from "./target-store";
import { storageLocalGet, storageLocalGetKeys, storageLocalRemove, storageLocalSet } from "./webext";

export interface CachedTarget extends TargetCounts {
  myReaction: Reaction | null;
  fetchedAt: number;
}

function normalizeCachedTargetCounts(raw: Partial<CachedTarget> | undefined): CachedTarget | null {
  if (!raw) return null;
  const counts = raw.counts ?? {};
  const total = typeof raw.total === "number" ? raw.total : Object.values(counts).reduce((s, v) => s + (typeof v === "number" ? v : 0), 0);
  const loaded = typeof raw.loaded === "number" ? raw.loaded : Object.keys(counts).length;
  return {
    counts,
    total,
    loaded,
    hasMore: !!raw.hasMore,
    myReaction: raw.myReaction ?? null,
    fetchedAt: raw.fetchedAt ?? 0,
  };
}

const COUNTS_CACHE_PREFIX = "cache:";

// The ONE place the prefix is applied - the sweep and the wholesale clear below
// find their entries by scanning for it, so a hand-written prefix elsewhere
// would leave that entry invisible to both.
function countsCacheKey(key: string): string {
  return `${COUNTS_CACHE_PREFIX}${key}`;
}

export async function getCachedCounts(targets: TargetRef[]): Promise<{ hits: Record<string, CachedTarget>; misses: TargetRef[] }> {
  const keyed = targets.map((target) => ({ target, key: targetKey(target) }));
  const stored = await storageLocalGet(keyed.map(({ key }) => countsCacheKey(key)));
  const now = Date.now();
  const hits: Record<string, CachedTarget> = {};
  const misses: TargetRef[] = [];
  for (const { target, key } of keyed) {
    const raw = stored[countsCacheKey(key)] as Partial<CachedTarget> | undefined;
    const cached = normalizeCachedTargetCounts(raw);
    if (cached && now - cached.fetchedAt < READ_CACHE_TTL_MS) {
      hits[key] = cached;
    } else {
      misses.push(target);
    }
  }
  return { hits, misses };
}

// Hard ceiling for the read-through cache, which is otherwise append-only (one entry per
// target the user scrolls past). Well above a session's live working set: the sweep below
// drops expired entries first and only reaches the cap on a very long session.
const COUNTS_CACHE_MAX_ENTRIES = 500;

async function countsCacheKeys(): Promise<string[]> {
  return (await storageLocalGetKeys()).filter((k) => k.startsWith(COUNTS_CACHE_PREFIX));
}

export async function clearCountsCache(): Promise<void> {
  const keys = await countsCacheKeys();
  if (keys.length > 0) await storageLocalRemove(keys);
}

const CACHE_SWEEP_AT_KEY = "cache_swept_at_v1";
const CACHE_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

// Sweep at most twice an hour. The background calls this on every service-worker start, and
// the worker starts on essentially every burst of extension use.
export async function maybeSweepCountsCache(): Promise<void> {
  const stored = await storageLocalGet([CACHE_SWEEP_AT_KEY]);
  const last = stored[CACHE_SWEEP_AT_KEY];
  if (typeof last === "number" && Date.now() - last < CACHE_SWEEP_INTERVAL_MS) return;
  await storageLocalSet({ [CACHE_SWEEP_AT_KEY]: Date.now() });
  await sweepCountsCache();
}

// Expired entries are already dead to getCachedCounts - they only occupy disk.
export async function sweepCountsCache(): Promise<void> {
  const keys = await countsCacheKeys();
  if (keys.length === 0) return;
  const stored = await storageLocalGet(keys);
  const now = Date.now();
  const live: Array<{ key: string; fetchedAt: number }> = [];
  const doomed: string[] = [];
  for (const key of keys) {
    const entry = normalizeCachedTargetCounts(stored[key] as Partial<CachedTarget> | undefined);
    if (!entry || now - entry.fetchedAt >= READ_CACHE_TTL_MS) doomed.push(key);
    else live.push({ key, fetchedAt: entry.fetchedAt });
  }
  if (live.length > COUNTS_CACHE_MAX_ENTRIES) {
    live.sort((a, b) => a.fetchedAt - b.fetchedAt);
    for (const { key } of live.slice(0, live.length - COUNTS_CACHE_MAX_ENTRIES)) doomed.push(key);
  }
  if (doomed.length > 0) await storageLocalRemove(doomed);
}

export async function setCachedCounts(byTargetKey: Record<string, { value: TargetCounts; myReaction: Reaction | null }>, opts: { skipIfCachedAfter?: number } = {}): Promise<void> {
  const now = Date.now();
  const keys = Object.keys(byTargetKey).map(countsCacheKey);
  const existing = opts.skipIfCachedAfter !== undefined && keys.length > 0 ? await storageLocalGet(keys) : {};
  const writes: Record<string, CachedTarget> = {};
  for (const [key, entry] of Object.entries(byTargetKey)) {
    if (opts.skipIfCachedAfter !== undefined) {
      const current = normalizeCachedTargetCounts(existing[countsCacheKey(key)] as Partial<CachedTarget> | undefined);
      if (current && current.fetchedAt >= opts.skipIfCachedAfter) continue;
    }
    writes[countsCacheKey(key)] = {
      counts: entry.value.counts,
      total: entry.value.total,
      loaded: entry.value.loaded,
      hasMore: entry.value.hasMore,
      myReaction: entry.myReaction,
      fetchedAt: now,
    };
  }
  if (Object.keys(writes).length === 0) return;
  await storageLocalSet(writes);
}

export async function applyOptimisticReaction(target: TargetRef, reaction: Reaction | null, userId: string): Promise<{ next: CachedTarget; prevReaction: Reaction | null }> {
  const key = countsCacheKey(targetKey(target));
  const stored = await storageLocalGet([key]);
  const prev: CachedTarget = normalizeCachedTargetCounts((stored[key] as Partial<CachedTarget> | undefined) ?? {})!;
  // Same derivation the picker paints with (shared/reaction-delta) - the two
  // must not drift, or a re-mount reads back a different number than the one on
  // screen.
  const counts = applyCountsDelta(prev.counts, prev.myReaction, reaction);
  const total = applyTotalDelta(prev.total, prev.myReaction, reaction);
  const loaded = Object.keys(counts).length;
  const next: CachedTarget = {
    counts,
    total,
    loaded,
    hasMore: prev.hasMore,
    myReaction: reaction,
    fetchedAt: Date.now(),
  };
  await storageLocalSet({ [key]: next });
  await setOwnReaction(target, reaction, userId);
  return { next, prevReaction: prev.myReaction };
}
