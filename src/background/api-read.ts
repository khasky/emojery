// SPDX-License-Identifier: GPL-3.0-or-later
//
// Read path: fetch a target's public counts plus the signed-in user's own
// reaction. Kept apart from api.ts (the durable vote-write queue): the read path
// shares only the API client and the session with it.

import type { TargetRef } from "../shared/adapter";
import { COUNTS_READ_BUDGET_MS } from "../shared/config";
import { deadlineSignal } from "../shared/fetch-deadline";
import type { ReactionCounts, TargetCounts } from "../shared/reactions";
import { DEFAULT_BREAKDOWN_LIMIT } from "../shared/reactions";
import { targetKey } from "../shared/storage";
import { ApiHttpError, type ApiReply, apiRequest, isRecord } from "./api-client";
import { logBackgroundError } from "./debug";
import { clearAuth, getAuth } from "./identity";
import { normalizeReaction } from "./message-guard";

// One retry is all a page read can afford. A `Retry-After` longer than this is
// more than a mounted trigger can wait through, so give up rather than retry late.
const READ_RETRY_MAX_DELAY_MS = 2_000;
const READ_RETRY_DEFAULT_DELAY_MS = 500;

function readRetryDelayMs(reply: ApiReply): number | null {
  if (reply.status !== 429 && reply.status < 500) return null;
  const delayMs = reply.retryAfterSeconds === undefined ? READ_RETRY_DEFAULT_DELAY_MS : reply.retryAfterSeconds * 1000;
  return delayMs <= READ_RETRY_MAX_DELAY_MS ? delayMs : null;
}

const inflightReads = new Map<string, Promise<TargetCounts>>();

// Negative cache: virtualized feeds rebuild mounts continuously, so an outage would
// re-issue a failed read per rebuilt mount. The stored rejection keeps its error class.
const FAILED_READ_TTL_MS = 60_000;
const FAILED_READ_MAX_ENTRIES = 500;
const failedReads = new Map<string, { at: number; error: unknown }>();

/** Test-only reset: the negative cache is module state and outlives a test's stubbed fetch. */
export function clearFailedReads(): void {
  failedReads.clear();
}

export function fetchCount(target: TargetRef, limit: number = DEFAULT_BREAKDOWN_LIMIT): Promise<TargetCounts> {
  const key = `${limit}|${targetKey(target)}`;
  const live = inflightReads.get(key);
  if (live) return live;
  const failed = failedReads.get(key);
  if (failed) {
    if (Date.now() - failed.at < FAILED_READ_TTL_MS) return Promise.reject(failed.error);
    failedReads.delete(key);
  }
  const read = fetchTargetCountsAndOwnReaction(target, limit)
    .then((counts) => {
      failedReads.delete(key);
      return counts;
    })
    .catch((error: unknown) => {
      failedReads.set(key, { at: Date.now(), error });
      if (failedReads.size > FAILED_READ_MAX_ENTRIES) {
        const oldest = failedReads.keys().next().value;
        if (oldest !== undefined) failedReads.delete(oldest);
      }
      throw error;
    })
    .finally(() => inflightReads.delete(key));
  inflightReads.set(key, read);
  return read;
}

// One /reactions/mine call covers a mount burst: every target asked for within
// this window goes in one request.
export const MINE_BATCH_WINDOW_MS = 25;
const MINE_MAX_TARGETS = 50;

interface MineBatch {
  /** Batches are per-token: a session change mid-window must not ride along. */
  token: string;
  targets: TargetRef[];
  flush: () => void;
  /** Drop the window timer without sending; the waiting reads settle on an empty map. */
  cancel: () => void;
  reactions: Promise<Record<string, string>>;
}

let pendingMine: MineBatch | null = null;

/** Test seam: the open batch is module state and outlives a test's stubbed fetch.
 *  Cancels the window timer too - an orphaned one still fires a real request - and
 *  settles the reads already waiting on that batch. */
export function clearPendingMineBatch(): void {
  pendingMine?.cancel();
  pendingMine = null;
}

function openMineBatch(token: string): MineBatch {
  const targets: TargetRef[] = [];
  let timer = 0;
  let cancelled = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const batch: MineBatch = {
    token,
    targets,
    flush: () => {
      if (timer === 0) return;
      self.clearTimeout(timer);
      timer = 0;
      if (pendingMine === batch) pendingMine = null;
      release();
    },
    cancel: () => {
      self.clearTimeout(timer);
      timer = 0;
      cancelled = true;
      release();
    },
    // A cancelled batch answers like a failed request - an empty map. Left pending, it
    // would hang every read waiting on it, and each one keeps its `inflightReads` slot,
    // so those targets stay unreadable until the worker restarts.
    reactions: gate.then(() => (cancelled ? {} : sendMineRequest(token, targets))),
  };
  timer = self.setTimeout(batch.flush, MINE_BATCH_WINDOW_MS);
  pendingMine = batch;
  return batch;
}

function requestMyReactions(target: TargetRef, token: string): Promise<Record<string, string>> {
  const batch = pendingMine?.token === token ? pendingMine : openMineBatch(token);
  batch.targets.push(target);
  if (batch.targets.length >= MINE_MAX_TARGETS) batch.flush();
  return batch.reactions;
}

/** The `site/targetId` token both reads send, and the key `mine` answers under.
 *  `targetKey()` (shared/storage) is the separate LOCAL key, spelled `site:targetId`. */
function wireTargetToken(target: TargetRef): string {
  return `${target.site}/${target.targetId}`;
}

// Resolves to a (possibly empty) map, never rejects: a missing own-reaction only
// costs the "you reacted" marker, and the shared promise is awaited by every
// target in the batch - one rejection would surface as that many failures.
async function sendMineRequest(token: string, targets: readonly TargetRef[]): Promise<Record<string, string>> {
  const query = targets.map((target) => `t=${encodeURIComponent(wireTargetToken(target))}`).join("&");
  try {
    // `no-store` for the same reason as the counts read below.
    const reply = await apiRequest(`/reactions/mine?${query}`, { method: "GET", token, cache: "no-store" });
    if (reply.status === 401) {
      await clearAuth();
      return {};
    }
    if (!reply.ok) return {};
    // `{ reactions: { "<site>/<targetId>": "🤣" } }` - the map is wrapped so
    // the response can grow a field without colliding with a target key.
    // Filtered to the requested targets and to emoji-shaped values rather than
    // trusted from a cast: the shared map is read per target key, so nothing
    // beyond this batch's keys has a reader, and a junk value would otherwise
    // travel into the counts cache as `myReaction`.
    //
    // Two key shapes, deliberately: the API answers under the same `site/targetId`
    // token this request sent, while `targetKey()` is the LOCAL storage key
    // (`site:targetId`) that the durable stores are already written under. Reading
    // the wire under one and returning the other keeps the rename on the wire
    // instead of turning it into a storage migration.
    const raw = isRecord(reply.body) && isRecord(reply.body.reactions) ? reply.body.reactions : {};
    const reactions: Record<string, string> = {};
    for (const target of targets) {
      const value = normalizeReaction(raw[wireTargetToken(target)]);
      if (value !== null) reactions[targetKey(target)] = value;
    }
    return reactions;
  } catch (error) {
    logBackgroundError("fetchOwnReaction.request", error);
    return {};
  }
}

// The counts body, held to its contract instead of trusted from a cast: the
// object lands in the counts cache and every mounted trigger renders it, so a
// broken (or compromised) API origin must not plant absurd values there. A
// malformed top-level shape rejects the read - the same surface as a non-ok
// status; counts entries are filtered per-entry and capped at the requested
// breakdown limit. Building a fresh object also drops any extra fields the
// response carried.
//
// `loaded` and `hasMore` are read leniently, since nothing renders either: the
// first is derived from what survives the filter below (the wire value counts the
// server's page, which the cap can shrink), the second coerced the way
// shared/counts-cache.ts reads the same fields back off disk. A body missing them
// then costs only the two numbers nothing shows.
function parseTargetCounts(raw: unknown, limit: number): TargetCounts {
  if (!isRecord(raw) || !isRecord(raw.counts) || !isCount(raw.total)) {
    throw new Error("malformed counts response");
  }
  const counts: ReactionCounts = {};
  let kept = 0;
  for (const [rawEmoji, count] of Object.entries(raw.counts)) {
    if (kept >= limit) break;
    const emoji = normalizeReaction(rawEmoji);
    if (emoji === null || counts[emoji] !== undefined || !isCount(count)) continue;
    counts[emoji] = count;
    kept++;
  }
  return { counts, total: raw.total, loaded: kept, hasMore: !!raw.hasMore };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function fetchTargetCountsAndOwnReaction(target: TargetRef, limit: number): Promise<TargetCounts> {
  const targetParam = wireTargetToken(target);
  const auth = await getAuth();
  // Both reads use `no-store`: the extension has its own read cache
  // (READ_CACHE_TTL_MS), so letting the browser HTTP layer also cache these could
  // resurface counts the user changed minutes ago.
  const countsP = fetchCountsWithRetry(`/reactions/count?t=${encodeURIComponent(targetParam)}&limit=${limit}`);
  // `mine` runs concurrently with `count`; a non-ok `count` throws below while
  // it is still in flight, which is safe because the batched read never rejects.
  const mineP = auth ? requestMyReactions(target, auth.token) : null;

  const base = parseTargetCounts((await countsP).body, limit);

  const myReaction = mineP ? ((await mineP)[targetKey(target)] ?? null) : null;
  return { ...base, myReaction };
}

// The counts read, retried once on a transient failure (429/5xx). A permanent
// status, an exhausted retry, or a `Retry-After` past the cap rejects with the
// status attached, so the caller can tell "rate limited" from "server down".
async function fetchCountsWithRetry(path: string): Promise<ApiReply> {
  // One deadline for both attempts. A deadline per attempt would let the retry
  // outlast the page's wait, so the trigger shows an error while this read runs on.
  const signal = deadlineSignal(COUNTS_READ_BUDGET_MS);
  const options = { method: "GET" as const, cache: "no-store" as const, ...(signal ? { signal } : {}) };
  const reply = await apiRequest(path, options);
  if (reply.ok) return reply;
  const retryInMs = readRetryDelayMs(reply);
  if (retryInMs === null) throw new ApiHttpError(reply.status);
  await new Promise<void>((resolve) => {
    self.setTimeout(resolve, retryInMs);
  });
  const retried = await apiRequest(path, options);
  if (!retried.ok) throw new ApiHttpError(retried.status);
  return retried;
}
