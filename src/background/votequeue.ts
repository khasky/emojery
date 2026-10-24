// SPDX-License-Identifier: GPL-3.0-or-later
//
// The vote queue: one record per (account, target) holding the DESIRED state of the pair, not
// a list of clicks. A click replaces the record's desire and raises its counter; the send
// builds and signs the vote from the record at that moment (no stored signature), so a retry,
// a new origin or a new key needs no re-signing pass. `base` is the reaction the server last
// confirmed for the pair; `counter` the counter of the last vote built for it.

import type { TargetRef } from "../shared/adapter";
import type { ReactionAction } from "../shared/messages";
import type { Reaction } from "../shared/reactions";
import { logIndexedDbDebug } from "./debug";
import { createIdbHandle, runTransaction } from "./idb-open";

const DB_NAME = "emojery-react-queue";
const STORE = "pairs";
const PAIR_INDEX = "pair";
// Confirmed state of pairs the queue no longer holds: the base and counter the next click
// builds on.
const KNOWN = "known";

export const VOTE_QUEUE_MAX = 500;

export interface QueuedVote {
  id?: number;
  /** `<userId>|<site>|<targetId>` */
  pair: string;
  userId: string;
  /** The key the record will be sent with; stamped at the first send, checked at every one. */
  enrollHash?: string;
  target: TargetRef;
  desired: Reaction | null;
  base: Reaction | null;
  counter: number;
  attempts: number;
  nextAttemptAt?: number;
  /** Wall clock of the first click still waiting in this record; the 24 h expiry counts from it. */
  firstQueuedAt: number;
  /** One state_conflict rebuilt already; a second rolls the click back. */
  conflictRebuilt?: boolean;
  lastError?: string;
  /** The click's history row, kept until the server answers. */
  historyReaction?: Reaction;
  historyAction?: ReactionAction;
  optimisticHistoryId?: string;
  title?: string;
  /** The reaction the page showed before the click: the rollback target. */
  rollbackTo: Reaction | null;
}

export type StoredVote = QueuedVote & { id: number };

export interface KnownPair {
  pair: string;
  reaction: Reaction | null;
  counter: number;
}

const queueDb = createIdbHandle(DB_NAME, 1, (db) => {
  if (!db.objectStoreNames.contains(STORE)) {
    const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
    store.createIndex(PAIR_INDEX, "pair", { unique: true });
  }
  if (!db.objectStoreNames.contains(KNOWN)) db.createObjectStore(KNOWN, { keyPath: "pair" });
});

export const pairKey = (userId: string, target: Pick<TargetRef, "site" | "targetId">): string => `${userId}|${target.site}|${target.targetId}`;

async function tx<T>(store: string | readonly string[], mode: IDBTransactionMode, operation: string, run: (s: IDBObjectStore, reject: (reason: unknown) => void) => () => T): Promise<T> {
  const startedAt = Date.now();
  const result = await runTransaction(await queueDb.open(), store, mode, `vote queue ${operation} aborted`, run);
  logIndexedDbDebug(operation, { store }, result, startedAt);
  return result;
}

/** A click: replaces the pair's record or creates it. The counter rises past every counter
 *  built for the pair, sent or not. Rejects when the queue is full. */
export function upsertClick(click: Omit<QueuedVote, "id" | "counter" | "attempts" | "firstQueuedAt" | "base" | "rollbackTo"> & { now: number; prevReaction: Reaction | null }): Promise<StoredVote> {
  return tx<StoredVote>([STORE, KNOWN], "readwrite", "upsertClick", (store, reject) => {
    let saved: StoredVote | undefined;
    const known = store.transaction.objectStore(KNOWN).get(click.pair);
    known.onsuccess = () => {
      const k = known.result as KnownPair | undefined;
      const existing = store.index(PAIR_INDEX).get(click.pair);
      existing.onsuccess = () => {
        const cur = existing.result as StoredVote | undefined;
        const base = cur ? cur.base : k ? k.reaction : click.prevReaction;
        const counter = Math.max(cur?.counter ?? 0, k?.counter ?? 0) + 1;
        const { now, prevReaction, ...fields } = click;
        const next: QueuedVote = {
          ...fields,
          ...(cur?.id !== undefined ? { id: cur.id } : {}),
          base,
          counter,
          attempts: 0,
          firstQueuedAt: cur?.firstQueuedAt ?? now,
          // The rollback target is what the page showed before the FIRST unsent click.
          rollbackTo: cur ? cur.rollbackTo : prevReaction,
        };
        const finish = (id: number) => {
          saved = { ...next, id };
        };
        if (cur) {
          store.put(next).onsuccess = () => finish(cur.id);
          return;
        }
        const count = store.count();
        count.onsuccess = () => {
          if (count.result >= VOTE_QUEUE_MAX) {
            reject(new Error(`vote queue full (${VOTE_QUEUE_MAX})`));
            store.transaction.abort();
            return;
          }
          const add = store.add(next);
          add.onsuccess = () => finish(add.result as number);
        };
      };
    };
    return () => saved as StoredVote;
  });
}

/** The first record (id order) whose own backoff has passed. */
export function peekNextEligible(now: number, skip: ReadonlySet<number> = new Set()): Promise<StoredVote | undefined> {
  return tx<StoredVote | undefined>(STORE, "readonly", "peekNextEligible", (store) => {
    let found: StoredVote | undefined;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const cur = cursor.result;
      if (!cur) return;
      const v = cur.value as StoredVote;
      if ((v.nextAttemptAt ?? 0) <= now && !skip.has(v.id)) found = v;
      else cur.continue();
    };
    return () => found;
  });
}

export function listQueuedVotes(limit: number): Promise<StoredVote[]> {
  return tx<StoredVote[]>(STORE, "readonly", "listQueuedVotes", (store) => {
    let votes: StoredVote[] = [];
    const req = store.getAll(undefined, limit);
    req.onsuccess = () => {
      votes = req.result as StoredVote[];
    };
    return () => votes;
  });
}

export function getQueueStats(): Promise<{ count: number; earliestNextAttemptAt?: number }> {
  return tx(STORE, "readonly", "getQueueStats", (store) => {
    let count = 0;
    let earliest: number | undefined;
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const cur = cursor.result;
      if (!cur) return;
      count++;
      const at = (cur.value as StoredVote).nextAttemptAt ?? 0;
      earliest = earliest === undefined ? at : Math.min(earliest, at);
      cur.continue();
    };
    return () => (earliest !== undefined ? { count, earliestNextAttemptAt: earliest } : { count });
  });
}

/** Writes the record back, unless a newer click replaced it meanwhile (its counter moved). */
export function updateVote(vote: StoredVote): Promise<void> {
  return tx<void>(STORE, "readwrite", "updateVote", (store) => {
    const req = store.get(vote.id);
    req.onsuccess = () => {
      const cur = req.result as StoredVote | undefined;
      if (cur && cur.counter <= vote.counter) store.put(vote);
    };
    return () => undefined;
  });
}

/** Settles a record the server answered for: drops it unless a newer click replaced it, and
 *  remembers the pair's confirmed state. */
export function settleVote(vote: StoredVote, confirmed: KnownPair | null): Promise<void> {
  return tx<void>([STORE, KNOWN], "readwrite", "settleVote", (store) => {
    const req = store.get(vote.id);
    req.onsuccess = () => {
      const cur = req.result as StoredVote | undefined;
      if (cur && cur.counter === vote.counter) store.delete(vote.id);
      else if (cur && confirmed) store.put({ ...cur, base: confirmed.reaction });
    };
    if (confirmed) store.transaction.objectStore(KNOWN).put(confirmed);
    return () => undefined;
  });
}

/** The confirmed state of pairs, as /v2/mine reported it. */
export function rememberPairs(pairs: KnownPair[]): Promise<void> {
  return tx<void>(KNOWN, "readwrite", "rememberPairs", (store) => {
    for (const p of pairs) store.put(p);
    return () => undefined;
  });
}

/** Drops an account's records (undefined: every record) and their known pairs. */
export function clearQueuedVotes(userId?: string): Promise<void> {
  return tx<void>([STORE, KNOWN], "readwrite", "clearQueuedVotes", (store) => {
    const prefix = userId === undefined ? "" : `${userId}|`;
    for (const name of [STORE, KNOWN]) {
      const cursor = store.transaction.objectStore(name).openCursor();
      cursor.onsuccess = () => {
        const cur = cursor.result;
        if (!cur) return;
        if ((cur.value as { pair: string }).pair.startsWith(prefix)) cur.delete();
        cur.continue();
      };
    }
    return () => undefined;
  });
}
