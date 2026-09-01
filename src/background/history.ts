// SPDX-License-Identifier: GPL-3.0-or-later
//
// Device-local reaction history in IndexedDB, uncapped - the History tab's stats and facets
// read the full record. The legacy storage.local format is imported once by
// migrateLegacyHistory() on service-worker startup (see there for its shape) and its key
// removed. Reads and search are paged here, never loading the whole store; the picker's recents
// stats update on write (shared/recents.ts), so content scripts never touch it.

import type { SupportedSite, TargetRef } from "../shared/adapter";
import type { HistoryStats, PortableHistoryRow, ReactionAction, ReactionHistoryItem } from "../shared/messages";
import type { Reaction } from "../shared/reactions";
import { bumpRecentEmoji, clearAllRecentEmojiStats, clearRecentEmojis, dropRecentEmoji, importRecentEmojiStats, type RecentEmojiStatsByUser } from "../shared/recents";
import { storageLocalGet, storageLocalRemove } from "../shared/webext";
import { logBackgroundError } from "./debug";
import { createIdbHandle } from "./idb-open";

const DB_NAME = "emojery-history";
const STORE = "history";
const VERSION = 1;
// Newest-first per-account pagination: the autoincrement id is insertion order.
// IndexedDB injects the generated id into the value before populating indexes,
// so a compound index on it is valid.
const USER_INDEX = "byUserAndId";
// Optimistic-row dedupe/rollback lookups; rows without a historyId are simply
// absent from this index.
const HISTORY_ID_INDEX = "byHistoryId";

// The pre-IndexedDB storage.local keys migrateLegacyHistory() consumes.
const LEGACY_HISTORY_KEY = "history";
const LEGACY_RECENTS_CLEARED_KEY = "frequent_cleared_v1";

interface HistoryPage {
  items: ReactionHistoryItem[];
  /** Continuation token (pass back as `cursor`) - null when the scan reached the end. */
  cursor: number | null;
}

// Connection lifecycle (versionchange / blocked / reopen) lives in idb-open.ts, shared
// with the vote queue - getting it right in only one of the two is the failure it exists
// to prevent.
const historyDb = createIdbHandle(DB_NAME, VERSION, (db) => {
  if (db.objectStoreNames.contains(STORE)) return;
  const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
  store.createIndex(USER_INDEX, ["userId", "id"]);
  store.createIndex(HISTORY_ID_INDEX, "historyId");
});

function openDb(): Promise<IDBDatabase> {
  return historyDb.open();
}

function buildRow(userId: string, target: TargetRef, reaction: Reaction, ts: number, opts: { historyId?: string; action?: ReactionAction; title?: string }): ReactionHistoryItem {
  return {
    ...(opts.historyId ? { historyId: opts.historyId } : {}),
    userId,
    target,
    reaction,
    ts,
    ...(opts.action ? { action: opts.action } : {}),
    ...(opts.title ? { title: opts.title } : {}),
  };
}

// `run` wires its request handlers on the store and returns a thunk read at
// oncomplete time for the resolve value; an abort with no tx.error rejects with a
// DOMException carrying `abortMessage`.
function runWrite<T>(db: IDBDatabase, storeName: string, abortMessage: string, run: (store: IDBObjectStore) => () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    const store = tx.objectStore(storeName);
    const getResult = run(store);
    tx.oncomplete = () => resolve(getResult());
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException(abortMessage));
  });
}

// Invalidates before AND again after the commit: a read that runs while the
// transaction is open can re-prime the caches from the pre-write rows.
async function runInvalidatingWrite<T>(db: IDBDatabase, storeName: string, abortMessage: string, run: (store: IDBObjectStore) => () => T): Promise<T> {
  invalidateHistoryCaches();
  const result = await runWrite(db, storeName, abortMessage, run);
  invalidateHistoryCaches();
  return result;
}

// What the dedupe-by-historyId branch found, so the recents stats can be
// adjusted after the transaction commits. `added` carries the generated id, which is
// what lets the read caches take the row without re-deriving themselves.
type PushOutcome = { added: number } | "confirmed-duplicate" | { movedFromUserId: string; movedReaction: Reaction };

export async function pushHistory(userId: string, target: TargetRef, reaction: Reaction, opts: { historyId?: string; ts?: number; action?: ReactionAction; title?: string } = {}): Promise<void> {
  const db = await openDb();
  const ts = opts.ts ?? Date.now();
  const outcome = await runWrite<PushOutcome>(db, STORE, "history push aborted", (store) => {
    let result: PushOutcome = { added: -1 };
    const addRow = () => {
      const add = store.add(buildRow(userId, target, reaction, ts, opts));
      // The re-home branch overwrites `result` with its own outcome before this fires,
      // so only a plain add ends up carrying the id.
      add.onsuccess = () => {
        if (typeof result === "object" && "added" in result) result = { added: add.result as number };
      };
    };
    if (opts.historyId) {
      const lookup = store.index(HISTORY_ID_INDEX).get(opts.historyId);
      lookup.onsuccess = () => {
        const existing = lookup.result as ReactionHistoryItem | undefined;
        if (existing?.id !== undefined) {
          if (existing.userId === userId) {
            result = "confirmed-duplicate";
            return;
          }
          // The optimistic row was written under a previous account; the
          // confirmation re-homes it to the account that owns the vote.
          store.delete(existing.id);
          result = { movedFromUserId: existing.userId, movedReaction: existing.reaction };
        }
        addRow();
      };
    } else {
      addRow();
    }
    return () => result;
  });
  // A confirmed duplicate wrote nothing, so it leaves the caches standing.
  if (outcome === "confirmed-duplicate") return;
  if ("added" in outcome) {
    // `added` is only ever below zero if the add request never reported its key,
    // which a committed transaction cannot do - handled rather than assumed.
    if (outcome.added >= 0) noteRowAdded(userId, outcome.added, reaction, target.site);
    else invalidateHistoryCaches();
  } else {
    // The re-home branch deleted another account's row and added one here; two
    // accounts changed, and only one of them is cached.
    invalidateHistoryCaches();
    // Recents stats are a soft quick-access list - never let their bookkeeping
    // fail a history write.
    await dropRecentEmoji(outcome.movedFromUserId, outcome.movedReaction).catch((error: unknown) => logBackgroundError("pushHistory.dropRecentEmoji", error));
  }
  await bumpRecentEmoji(userId, reaction, ts).catch((error: unknown) => logBackgroundError("pushHistory.bumpRecentEmoji", error));
}

export async function removeHistoryEntry(historyId: string): Promise<void> {
  const db = await openDb();
  const removed = await runWrite<(ReactionHistoryItem & { id: number }) | null>(db, STORE, "history remove aborted", (store) => {
    let removedRow: (ReactionHistoryItem & { id: number }) | null = null;
    const lookup = store.index(HISTORY_ID_INDEX).get(historyId);
    lookup.onsuccess = () => {
      const row = lookup.result as ReactionHistoryItem | undefined;
      if (row?.id !== undefined) {
        removedRow = { ...row, id: row.id };
        store.delete(row.id);
      }
    };
    return () => removedRow;
  });
  if (!removed) return; // No row matched that historyId: nothing changed, caches stand.
  noteRowRemoved(removed.userId, removed.id, removed.reaction, removed.target.site);
  await dropRecentEmoji(removed.userId, removed.reaction).catch((error: unknown) => logBackgroundError("removeHistoryEntry.dropRecentEmoji", error));
}

// `query` must already be trimmed + lowercased.
function matchesHistoryQuery(row: ReactionHistoryItem, query: string): boolean {
  return `${row.target.url} ${row.target.site ?? ""} ${row.reaction}`.toLowerCase().includes(query);
}

interface ResolvedHistoryFilter {
  query: string;
  site: SupportedSite | undefined;
  emoji: Reaction | undefined;
  since: number | undefined;
}

function passesHistoryFilter(row: ReactionHistoryItem, filter: ResolvedHistoryFilter): boolean {
  if (filter.query && !matchesHistoryQuery(row, filter.query)) return false;
  if (filter.site && row.target.site !== filter.site) return false;
  if (filter.emoji && row.reaction !== filter.emoji) return false;
  if (filter.since != null && row.ts < filter.since) return false;
  return true;
}

function requestAsPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// Rows per batched index read (search, filtered paging, stats). Batched getAll() instead of a
// cursor walk: WebKit serializes each cursor.continue() into its own IPC roundtrip, which puts
// a per-row cost on the walk and makes it unusable in Safari; getAll() moves a batch in one.
export const SEARCH_BATCH = 1_000;

// Worker-memory caches for the popup's read paths: caching the account's full id list for the
// popup session turns paging from O(pages x rows) into O(rows), and the stats scan reruns only
// after a history write. Freshness is checked per request via index.count(), so an equal-count
// replacement needs an explicit invalidate (see importHistory).
let idListCache: { userId: string; ids: number[]; count: number } | null = null;
let statsCache: { userId: string; stats: HistoryStats; count: number } | null = null;

function invalidateHistoryCaches(): void {
  idListCache = null;
  statsCache = null;
}

// A single-row write applies its delta to the caches; anything it cannot account for
// EXACTLY drops both caches rather than leave a plausible-looking wrong total behind.
function noteRowAdded(userId: string, id: number, reaction: Reaction, site: SupportedSite): void {
  const ids = idListCache;
  // Autoincrement ids only grow, so anything not past the tail means this row is
  // already in the list (a read primed the cache after the commit) - leave it alone.
  if (!ids || ids.userId !== userId || id <= (ids.ids[ids.ids.length - 1] ?? Number.NEGATIVE_INFINITY)) {
    invalidateHistoryCaches();
    return;
  }
  ids.ids.push(id);
  ids.count = ids.ids.length;
  bumpStats(userId, ids.ids.length, reaction, site, 1);
}

function noteRowRemoved(userId: string, id: number, reaction: Reaction, site: SupportedSite): void {
  const ids = idListCache;
  const at = ids && ids.userId === userId ? lowerBoundIndex(ids.ids, id) : -1;
  if (!ids || at < 0 || ids.ids[at] !== id) {
    invalidateHistoryCaches();
    return;
  }
  ids.ids.splice(at, 1);
  ids.count = ids.ids.length;
  bumpStats(userId, ids.ids.length, reaction, site, -1);
}

// Rebuilt rather than mutated: getHistoryStats hands the cached object straight to its
// caller, so the entry a popup is already holding must not change under it.
function bumpStats(userId: string, nextCount: number, reaction: Reaction, site: SupportedSite, delta: 1 | -1): void {
  const cached = statsCache;
  if (!cached || cached.userId !== userId || cached.count !== nextCount - delta) {
    statsCache = null;
    return;
  }
  const byEmoji = { ...cached.stats.byEmoji };
  const bySite = { ...cached.stats.bySite };
  applyStatsDelta(byEmoji, reaction, delta);
  applyStatsDelta(bySite, site, delta);
  statsCache = { userId, count: nextCount, stats: { total: cached.stats.total + delta, byEmoji, bySite } };
}

// A key that falls to zero is dropped, not kept at 0: the facet lists render every key
// they find, and a rebuilt-from-scratch scan would never have emitted the empty one.
function applyStatsDelta(counts: Record<string, number>, key: string, delta: 1 | -1): void {
  const next = (counts[key] ?? 0) + delta;
  if (next > 0) counts[key] = next;
  else delete counts[key];
}

// Every row of one account over the [userId, id] index - the range each
// per-account read, export and delete walks.
function userKeyRange(userId: string): IDBKeyRange {
  return IDBKeyRange.bound([userId, -Infinity], [userId, Infinity]);
}

async function getUserIdList(index: IDBIndex, userId: string): Promise<number[]> {
  const range = userKeyRange(userId);
  const count = await requestAsPromise(index.count(range));
  if (idListCache && idListCache.userId === userId && idListCache.count === count) {
    return idListCache.ids;
  }
  const ids = (await requestAsPromise(index.getAllKeys(range))) as number[];
  idListCache = { userId, ids, count };
  return ids;
}

// First index whose id is >= cursor, over the ascending id list.
function lowerBoundIndex(ids: number[], cursor: number): number {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ids[mid]! < cursor) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// One page of an account's history, newest first. `cursor` is the id of the last row a previous
// page returned - the scan resumes strictly below it, so pages never overlap while new rows
// land on top.
export async function getHistoryPage(userId: string, opts: { limit: number; cursor?: number | null; query?: string; site?: SupportedSite; emoji?: Reaction; since?: number }): Promise<HistoryPage> {
  const db = await openDb();
  const filter: ResolvedHistoryFilter = { query: opts.query?.trim().toLowerCase() ?? "", site: opts.site, emoji: opts.emoji, since: opts.since };
  const hasFilter = !!(filter.query || filter.site || filter.emoji || filter.since != null);
  const tx = db.transaction(STORE, "readonly");
  const index = tx.objectStore(STORE).index(USER_INDEX);
  const allIds = await getUserIdList(index, userId);
  const ids = opts.cursor != null ? allIds.slice(0, lowerBoundIndex(allIds, opts.cursor)) : allIds;

  const items: ReactionHistoryItem[] = [];
  let scanEnd = ids.length; // exclusive; walks toward 0 (newest to oldest)
  while (scanEnd > 0 && items.length < opts.limit) {
    // Any active filter drops rows, so fetch a wide batch (like search) instead
    // of exactly `limit`; an unfiltered page fetches just what it returns.
    const batchSize = hasFilter ? SEARCH_BATCH : opts.limit;
    const scanStart = Math.max(0, scanEnd - batchSize);
    const batchRange = IDBKeyRange.bound([userId, ids[scanStart]!], [userId, ids[scanEnd - 1]!]);
    const rows = (await requestAsPromise(index.getAll(batchRange))) as ReactionHistoryItem[];
    for (let i = rows.length - 1; i >= 0 && items.length < opts.limit; i--) {
      const row = rows[i]!;
      if (passesHistoryFilter(row, filter)) items.push(row);
    }
    scanEnd = scanStart;
  }

  const reachedOldestRow = items.length > 0 && items[items.length - 1]!.id === ids[0];
  const exhausted = items.length < opts.limit || reachedOldestRow;
  return { items, cursor: exhausted ? null : (items[items.length - 1]!.id ?? null) };
}

// One full scan of an account's history into device-local aggregates for the History tab's
// facet distributions. O(history), but cached in worker memory and rerun only after a history
// write.
export async function getHistoryStats(userId: string): Promise<HistoryStats> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const index = tx.objectStore(STORE).index(USER_INDEX);
  const ids = await getUserIdList(index, userId);
  if (statsCache && statsCache.userId === userId && statsCache.count === ids.length) {
    return statsCache.stats;
  }
  // Freshly built, not the shared EMPTY_HISTORY_STATS const - the caller owns
  // the object it gets back, and that const's maps must stay empty.
  if (ids.length === 0) return { total: 0, byEmoji: {}, bySite: {} };

  const byEmoji: Record<string, number> = {};
  const bySite: Record<string, number> = {};
  let total = 0;

  for (let start = 0; start < ids.length; start += SEARCH_BATCH) {
    const end = Math.min(ids.length, start + SEARCH_BATCH);
    const batchRange = IDBKeyRange.bound([userId, ids[start]!], [userId, ids[end - 1]!]);
    const rows = (await requestAsPromise(index.getAll(batchRange))) as ReactionHistoryItem[];
    for (const row of rows) {
      total++;
      byEmoji[row.reaction] = (byEmoji[row.reaction] ?? 0) + 1;
      bySite[row.target.site] = (bySite[row.target.site] ?? 0) + 1;
    }
  }

  const stats = { total, byEmoji, bySite };
  statsCache = { userId, stats, count: ids.length };
  return stats;
}

// Identity of a reaction event within one import file, used to drop in-file
// repeats. Adapter-derived targetIds carry no space; a hand-edited one could, at
// worst collapsing two rows of the same file.
function portableKey(row: PortableHistoryRow): string {
  return `${row.site} ${row.targetId} ${row.reaction} ${row.ts} ${row.action ?? ""}`;
}

// The account's whole history as portable rows (oldest first) for a local JSON download; drops
// device-local ids and the userId. One getAll() materializes the account's rows.
export async function exportHistory(userId: string): Promise<PortableHistoryRow[]> {
  const db = await openDb();
  const tx = db.transaction(STORE, "readonly");
  const index = tx.objectStore(STORE).index(USER_INDEX);
  const rows = (await requestAsPromise(index.getAll(userKeyRange(userId)))) as ReactionHistoryItem[];
  return rows.map((row) => ({ site: row.target.site, targetId: row.target.targetId, targetUrl: row.target.url, reaction: row.reaction, ts: row.ts, ...(row.action ? { action: row.action } : {}) }));
}

// Re-home portable rows to the current account, dropping rows that repeat within the file.
function buildImportRows(userId: string, rows: PortableHistoryRow[]): ReactionHistoryItem[] {
  const seen = new Set<string>();
  const out: ReactionHistoryItem[] = [];
  for (const row of rows) {
    const key = portableKey(row);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(buildRow(userId, { site: row.site, targetId: row.targetId, url: row.targetUrl }, row.reaction, row.ts, row.action ? { action: row.action } : {}));
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Replace the account's whole history in one readwrite transaction (other
// accounts untouched), so a failure leaves the prior history intact. The
// derived recents blob is left to self-heal on the next reaction.
export async function importHistory(userId: string, rows: PortableHistoryRow[]): Promise<{ imported: number; replaced: number }> {
  const fresh = buildImportRows(userId, rows);
  const db = await openDb();
  return runInvalidatingWrite<{ imported: number; replaced: number }>(db, STORE, "history import aborted", (store) => {
    let replaced = 0;
    const priorKeys = store.index(USER_INDEX).getAllKeys(userKeyRange(userId));
    priorKeys.onsuccess = () => {
      const ids = priorKeys.result as number[];
      replaced = ids.length;
      for (const id of ids) store.delete(id);
      for (const row of fresh) store.add(row);
    };
    return () => ({ imported: fresh.length, replaced });
  });
}

// Rows must be oldest-first so the autoincrement id preserves display order.
export async function importHistoryRows(rows: ReactionHistoryItem[]): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDb();
  await runInvalidatingWrite<void>(db, STORE, "history import aborted", (store) => {
    for (const row of rows) store.add(row);
    return () => undefined;
  });
}

// Account deletion: drop one account's rows and its derived recents, leaving
// every other account on the device untouched - the same per-account contract
// importHistory keeps.
export async function clearHistoryForUser(userId: string): Promise<void> {
  const db = await openDb();
  await runInvalidatingWrite<void>(db, STORE, "history clear aborted", (store) => {
    const keys = store.index(USER_INDEX).getAllKeys(userKeyRange(userId));
    keys.onsuccess = () => {
      for (const id of keys.result as number[]) store.delete(id);
    };
    return () => undefined;
  });
  await clearRecentEmojis(userId).catch((error: unknown) => logBackgroundError("clearHistoryForUser.clearRecentEmojis", error));
}

// Wholesale wipe of every account's rows. Only the pre-`userId` deletion-resume
// marker still needs it (background/identity.ts) - a scoped delete is impossible
// there because nothing in that marker names the account.
export async function clearHistory(): Promise<void> {
  const db = await openDb();
  await runInvalidatingWrite<void>(db, STORE, "history clear aborted", (store) => {
    store.clear();
    return () => undefined;
  });
  await clearAllRecentEmojiStats().catch((error: unknown) => logBackgroundError("clearHistory.clearRecentEmojiStats", error));
}

// One-time import of the pre-IndexedDB storage.local history array (newest first, <=1000 rows
// per account) plus the picker's old per-user "recents cleared at" marker. Removing the storage
// keys marks the migration done; a failed remove would re-import duplicates on the next wake -
// a broken-profile case, accepted.
export async function migrateLegacyHistory(): Promise<void> {
  const stored = await storageLocalGet([LEGACY_HISTORY_KEY, LEGACY_RECENTS_CLEARED_KEY]);
  const legacyRows = stored[LEGACY_HISTORY_KEY] as ReactionHistoryItem[] | undefined;
  const hadMarker = stored[LEGACY_RECENTS_CLEARED_KEY] !== undefined;
  if (!Array.isArray(legacyRows)) {
    if (hadMarker) await storageLocalRemove([LEGACY_RECENTS_CLEARED_KEY]);
    return;
  }
  if (legacyRows.length > 0) {
    await importHistoryRows([...legacyRows].reverse());
    const clearedAt = (stored[LEGACY_RECENTS_CLEARED_KEY] as Record<string, number> | undefined) ?? {};
    const stats: RecentEmojiStatsByUser = {};
    for (const row of legacyRows) {
      if (row.ts <= (clearedAt[row.userId] ?? 0)) continue;
      const userStats = stats[row.userId] ?? {};
      stats[row.userId] = userStats;
      const current = userStats[row.reaction];
      userStats[row.reaction] = {
        count: (current?.count ?? 0) + 1,
        lastUsed: Math.max(current?.lastUsed ?? 0, row.ts),
      };
    }
    await importRecentEmojiStats(stats).catch((error: unknown) => logBackgroundError("migrateLegacyHistory.importRecentEmojiStats", error));
  }
  await storageLocalRemove([LEGACY_HISTORY_KEY, LEGACY_RECENTS_CLEARED_KEY]);
}
