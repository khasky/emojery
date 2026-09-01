// SPDX-License-Identifier: GPL-3.0-or-later
//
// The `<site>:<targetId>` key every stored per-target record is filed under, and
// the two durable, account-scoped stores built on it: the user's own reaction
// and the native control the extension pressed on their behalf.

import type { TargetRef } from "./adapter";
import type { NativeAutoAction } from "./native-actions";
import type { Reaction } from "./reactions";
import { storageLocalGet, storageLocalSet } from "./webext";

declare const TARGET_KEY_BRAND: unique symbol;
/**
 * `<site>:<targetId>`, branded so it can't be swapped with a bare `targetId` or a
 * `cache:`-prefixed storage key. Build one with `targetKey()` - never by hand.
 */
export type TargetKey = string & { readonly [TARGET_KEY_BRAND]: true };

export function targetKey(t: TargetRef): TargetKey {
  return `${t.site}:${t.targetId}` as TargetKey;
}

// Pre-account-scoping store (no owner) - entries can't be attributed to an
// account, so the background drops the key at SW startup instead of migrating.
export const LEGACY_OWN_REACTIONS_KEY = "own_reactions_v1";

// Both durable per-target stores below are one storage.local key holding
// `<site>:<targetId>` -> an owner-stamped entry, read-modify-written IN FULL on
// the click path, so their size is a per-click parse/serialize cost as well as a
// storage one. The cap keeps that bounded; the server's /reactions/mine remains
// the authoritative record for evicted targets.
const MAP_STORE_MAX_ENTRIES = 1000;

/** The account stamp and eviction order every entry shape shares. The VALUE field
 *  differs per store (`reaction` / `action`) and is persisted under that name, so
 *  each store declares its own entry type rather than sharing one. */
interface UserScopedEntry {
  userId: string;
  /** Epoch-ms of the write - eviction order. Missing on legacy entries (evicted first). */
  ts?: number;
}

/** How one store reads its value out of a stored entry and builds a fresh one. */
interface UserScopedEntrySpec<V, Entry extends UserScopedEntry> {
  isEntry(value: unknown): value is Entry;
  valueOf(entry: Entry): V;
  build(value: V, userId: string, ts: number): Entry;
}

function evictOldestEntries(map: Record<string, UserScopedEntry>, max: number): void {
  const keys = Object.keys(map);
  if (keys.length <= max) return;
  keys.sort((a, b) => (map[a]?.ts ?? 0) - (map[b]?.ts ?? 0));
  for (const key of keys.slice(0, keys.length - max)) delete map[key];
}

/**
 * A durable, account-scoped `TargetRef -> value` store behind one storage.local
 * key. The rules it owns once for both stores: a read only sees the CURRENT
 * account's entry, an erase only touches that account's, a no-op write is
 * skipped, and growth is capped by oldest-first eviction. A later sign-in must
 * never inherit another account's records as its own.
 */
function createUserScopedTargetStore<V, Entry extends UserScopedEntry>(storeKey: string, spec: UserScopedEntrySpec<V, Entry>) {
  // A scan mounts many triggers at once and each one reads the whole map - one
  // storage round-trip plus a validation pass over up to MAP_STORE_MAX_ENTRIES
  // entries per trigger. Overlapping READS share one; the slot clears the moment
  // it settles, so it is a per-burst dedupe, never a cache that outlives its
  // read. The shared map is READ-ONLY; every writer takes its own `read()` so its
  // read-modify-write owns the object it mutates.
  let inFlightRead: Promise<Record<string, Entry>> | null = null;

  // Every mutator below is a read-modify-write of ONE key holding the WHOLE map -
  // two running at once would drop each other's entry, hence the chain. Scoped to
  // this JS context: two TABS still race; the server's /reactions/mine stays the authority there.
  let writeChain: Promise<unknown> = Promise.resolve();

  // Same handler for both settle paths: a failed mutator must not poison the chain
  // for the next one. The caller still sees its own rejection through `next`.
  const serializeWrite = <T>(run: () => Promise<T>): Promise<T> => {
    const next = writeChain.then(run, run);
    writeChain = next.catch(() => {});
    return next;
  };

  const read = async (): Promise<Record<string, Entry>> => {
    const stored = await storageLocalGet([storeKey]);
    const raw = stored[storeKey];
    if (!raw || typeof raw !== "object") return {};
    const map: Record<string, Entry> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      if (spec.isEntry(value)) map[key] = value;
    }
    return map;
  };

  const sharedRead = (): Promise<Record<string, Entry>> => {
    if (inFlightRead) return inFlightRead;
    const pending = read().finally(() => {
      if (inFlightRead === pending) inFlightRead = null;
    });
    inFlightRead = pending;
    return pending;
  };

  const get = async (target: TargetRef, userId: string): Promise<V | null> => {
    const map = await sharedRead();
    const entry = map[targetKey(target)];
    return entry && entry.userId === userId ? spec.valueOf(entry) : null;
  };

  const set = (target: TargetRef, value: V | null, userId: string): Promise<void> =>
    serializeWrite(async () => {
      const map = await read();
      const key = targetKey(target);
      const entry = map[key];
      if (value === null) {
        if (!entry || entry.userId !== userId) return;
        delete map[key];
      } else {
        if (entry && entry.userId === userId && spec.valueOf(entry) === value) return;
        map[key] = spec.build(value, userId, Date.now());
        evictOldestEntries(map, MAP_STORE_MAX_ENTRIES);
      }
      await storageLocalSet({ [storeKey]: map });
    });

  // Erase only while the stored value still matches - a stale caller must not
  // wipe a value written after it.
  const deleteIfValueMatches = (target: TargetRef, value: V, userId: string): Promise<void> =>
    serializeWrite(async () => {
      const map = await read();
      const key = targetKey(target);
      const entry = map[key];
      if (!entry || entry.userId !== userId || spec.valueOf(entry) !== value) return;
      delete map[key];
      await storageLocalSet({ [storeKey]: map });
    });

  // Drop every entry one account owns, leaving the other accounts' in place.
  // Account deletion is per-account: a second account signed in on the same
  // device keeps its own records.
  const clearForUser = (userId: string): Promise<void> =>
    serializeWrite(async () => {
      const map = await read();
      let changed = false;
      for (const [key, entry] of Object.entries(map)) {
        if (entry.userId !== userId) continue;
        delete map[key];
        changed = true;
      }
      if (changed) await storageLocalSet({ [storeKey]: map });
    });

  return { get, set, deleteIfValueMatches, clearForUser };
}

// Durable per-target record of the user's own reaction, independent of the counts
// cache (whose entries expire after READ_CACHE_TTL_MS, shared/config.ts), so a
// re-mount or cache expiry can't drop it. A definite server
// reaction wins in the overlay; this store only fills a null. Cleared on
// explicit un-react and on a rejected queued vote (background/api).
const OWN_REACTIONS_KEY = "own_reactions_v2";

interface OwnReactionEntry extends UserScopedEntry {
  reaction: Reaction;
}

const ownReactions = createUserScopedTargetStore<Reaction, OwnReactionEntry>(OWN_REACTIONS_KEY, {
  isEntry: (value): value is OwnReactionEntry => {
    if (!value || typeof value !== "object") return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.reaction === "string" && typeof entry.userId === "string";
  },
  valueOf: (entry) => entry.reaction,
  build: (reaction, userId, ts) => ({ reaction, userId, ts }),
});

export function getOwnReaction(target: TargetRef, userId: string): Promise<Reaction | null> {
  return ownReactions.get(target, userId);
}

// Production writes route through counts-cache.ts applyOptimisticReaction (which
// calls this) or clearOwnReactionIfMatches below - never this function directly.
export function setOwnReaction(target: TargetRef, reaction: Reaction | null, userId: string): Promise<void> {
  return ownReactions.set(target, reaction, userId);
}

// Clear the stored own-reaction only while it still matches `reaction` for the
// SAME account - a rejected/dropped queued vote must not wipe a NEWER
// own-reaction, nor a different account's entry.
export function clearOwnReactionIfMatches(target: TargetRef, reaction: Reaction, userId: string): Promise<void> {
  return ownReactions.deleteIfValueMatches(target, reaction, userId);
}

export function clearOwnReactionsForUser(userId: string): Promise<void> {
  return ownReactions.clearForUser(userId);
}

// Which native control the extension itself pressed per target ("Auto-press
// native buttons"). Needed so un-react/neutral only ever un-presses OUR press,
// never a like the user set by hand before us.
const AUTO_NATIVE_KEY = "auto_native_v1";

interface AutoNativeEntry extends UserScopedEntry {
  action: NativeAutoAction;
}

const autoNatives = createUserScopedTargetStore<NativeAutoAction, AutoNativeEntry>(AUTO_NATIVE_KEY, {
  isEntry: (value): value is AutoNativeEntry => {
    if (!value || typeof value !== "object") return false;
    const entry = value as Record<string, unknown>;
    return typeof entry.action === "string" && typeof entry.userId === "string";
  },
  valueOf: (entry) => entry.action,
  build: (action, userId, ts) => ({ action, userId, ts }),
});

export function getAutoNative(target: TargetRef, userId: string): Promise<NativeAutoAction | null> {
  return autoNatives.get(target, userId);
}

export function setAutoNative(target: TargetRef, action: NativeAutoAction | null, userId: string): Promise<void> {
  return autoNatives.set(target, action, userId);
}

export function clearAutoNativesForUser(userId: string): Promise<void> {
  return autoNatives.clearForUser(userId);
}
