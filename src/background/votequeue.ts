// SPDX-License-Identifier: GPL-3.0-or-later
//
// Durable vote queue backed by IndexedDB.

import type { TargetRef } from "../shared/adapter";
import type { ReactionAction } from "../shared/messages";
import type { Reaction } from "../shared/reactions";
import { logIndexedDbDebug } from "./debug";
import { createIdbHandle } from "./idb-open";

const DB_NAME = "emojery-vote-queue";
const STORE = "votes";
const VERSION = 1;

// Bound on offline growth: past this, enqueue refuses and the click's optimistic
// state is rolled back by the caller - a visible "didn't stick" beats a queue
// that drains for minutes after reconnect.
export const VOTE_QUEUE_MAX = 500;

// The shape callers ENQUEUE: no id yet, IndexedDB assigns it on `add`.
export interface QueuedVote {
  id?: number;
  target: TargetRef;
  reaction: Reaction | null;
  ts: number;
  attempts: number;
  /** Account that cast the vote; the flush drops an entry whose owner no longer matches the session
   * rather than sending it with the new token. Optional only for pre-stamp legacy rows (dropped at flush). */
  userId?: string;
  /** Snapshot of effective analytics consent at click time. Missing legacy rows default on. */
  analyticsConsent?: boolean;
  /** Page/browser language fallback captured at click time. */
  lang?: string;
  /** Emoji the user clicked, even when the queued reaction is an unreact. */
  historyReaction?: Reaction;
  /** Whether the click added, removed, or changed the reaction (history tint). */
  historyAction?: ReactionAction;
  /** Local-only id of the optimistic history row. */
  optimisticHistoryId?: string;
  /** Page title at click time - stored device-locally for the History list. */
  title?: string;
  /** Epoch-ms before which this vote's own retry must not run. Missing (legacy
   * rows and fresh enqueues) means eligible now. Per-vote so one failing vote
   * backs itself off without blocking the rest of the queue. */
  nextAttemptAt?: number;
}

// The shape the queue READS BACK: the store's keyPath is `id` with
// autoIncrement, so anything a cursor yields has one. Read paths take this so
// the drain loop can pass `v.id` to deleteById/bumpAttempt without asserting.
export type StoredVote = QueuedVote & { id: number };

// Connection lifecycle (versionchange / blocked / reopen) lives in idb-open.ts, shared
// with the history store. It matters most here: the popup's Debug tab holds a second
// connection to THIS database while the worker drains it.
const queueDb = createIdbHandle(DB_NAME, VERSION, (db) => {
  if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
});

function openDb(): Promise<IDBDatabase> {
  return queueDb.open();
}

interface QueueStats {
  count: number;
  /** Earliest epoch-ms at which any queued vote becomes eligible; 0 when one is eligible now. Undefined when empty. */
  earliestNextAttemptAt?: number;
}

// The same transaction lifecycle as history.ts's runWrite, plus the dev trace. `run` may
// also reject early (enqueue's full-queue guard) through the `reject` it is handed;
// `toLog` reshapes the traced response.
async function runQueueTx<T>(mode: IDBTransactionMode, operation: string, requestPayload: Record<string, unknown>, run: (store: IDBObjectStore, reject: (reason: unknown) => void) => () => T, toLog: (result: T) => unknown = (result) => result): Promise<T> {
  const startedAt = Date.now();
  const db = await openDb();
  const result = await new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const getResult = run(tx.objectStore(STORE), reject);
    tx.oncomplete = () => resolve(getResult());
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException(`vote queue ${operation} aborted`));
  });
  logIndexedDbDebug(operation, { store: STORE, ...requestPayload }, toLog(result), startedAt);
  return result;
}

export function enqueue(vote: Omit<QueuedVote, "id">): Promise<number> {
  return runQueueTx<number>(
    "readwrite",
    "enqueue",
    { vote },
    (store, reject) => {
      let id = 0;
      const countReq = store.count();
      countReq.onsuccess = () => {
        if (countReq.result >= VOTE_QUEUE_MAX) {
          reject(new Error(`vote queue full (${VOTE_QUEUE_MAX})`));
          store.transaction.abort();
          return;
        }
        const req = store.add(vote);
        req.onsuccess = () => {
          id = req.result as number;
        };
      };
      return () => id;
    },
    (id) => ({ id }),
  );
}

// First vote in id order, backoff ignored. The sign-out drain uses it to tell
// "the head moved" from "the head failed again".
export function peekNext(): Promise<StoredVote | undefined> {
  return runQueueTx<StoredVote | undefined>(
    "readonly",
    "peekNext",
    {},
    (store) => {
      let head: StoredVote | undefined;
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (cur) head = cur.value as StoredVote;
      };
      return () => head;
    },
    (vote) => ({ vote: vote ?? null }),
  );
}

/** First vote (in id order) whose own backoff has expired, or undefined. */
export function peekNextEligible(now: number): Promise<StoredVote | undefined> {
  return runQueueTx<StoredVote | undefined>(
    "readonly",
    "peekNextEligible",
    { now },
    (store) => {
      let eligible: StoredVote | undefined;
      const cursor = store.openCursor();
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (!cur) return;
        const vote = cur.value as StoredVote;
        if ((vote.nextAttemptAt ?? 0) <= now) eligible = vote;
        else cur.continue();
      };
      return () => eligible;
    },
    (vote) => ({ vote: vote ?? null }),
  );
}

// Oldest-first snapshot of the queue, capped at `limit` - read-only, and read by
// the popup's Debug tab only. One getAll() instead of a cursor walk, like
// history.ts: a per-row IPC round trip is the wrong cost for a panel that
// refreshes on a timer.
export function listQueuedVotes(limit: number): Promise<StoredVote[]> {
  return runQueueTx<StoredVote[]>(
    "readonly",
    "listQueuedVotes",
    { limit },
    (store) => {
      let votes: StoredVote[] = [];
      const request = store.getAll(undefined, limit);
      request.onsuccess = () => {
        votes = request.result as StoredVote[];
      };
      return () => votes;
    },
    (votes) => ({ count: votes.length }),
  );
}

export function getQueueStats(): Promise<QueueStats> {
  return runQueueTx<QueueStats>("readonly", "getQueueStats", {}, (store) => {
    let count = 0;
    let earliest: number | undefined;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const cur = cursor.result;
      if (!cur) return;
      count += 1;
      const nextAttemptAt = (cur.value as StoredVote).nextAttemptAt ?? 0;
      earliest = earliest === undefined ? nextAttemptAt : Math.min(earliest, nextAttemptAt);
      cur.continue();
    };
    return () => (earliest !== undefined ? { count, earliestNextAttemptAt: earliest } : { count });
  });
}

export async function deleteById(id: number): Promise<void> {
  await runQueueTx<void>(
    "readwrite",
    "deleteById",
    { id },
    (store) => {
      store.delete(id);
      return () => undefined;
    },
    () => ({ deleted: 1 }),
  );
}

export async function bumpAttempt(id: number, nextAttemptAt?: number): Promise<void> {
  await runQueueTx<void>(
    "readwrite",
    "bumpAttempt",
    { id, nextAttemptAt },
    (store) => {
      const req = store.get(id);
      req.onsuccess = () => {
        const vote = req.result as QueuedVote | undefined;
        if (!vote) return;
        vote.attempts = (vote.attempts ?? 0) + 1;
        if (nextAttemptAt !== undefined) vote.nextAttemptAt = nextAttemptAt;
        store.put(vote);
      };
      return () => undefined;
    },
    () => ({ bumped: 1 }),
  );
}
