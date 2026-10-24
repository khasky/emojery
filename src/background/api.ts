// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sending the vote queue (votequeue.ts): each record is built and signed when it is sent -
// REACT over the log's current origin, the key's enroll_hash, the pair's base and the
// record's counter - and the server's answer decides what happens to it, the pair's other
// records and the queue as a whole.

import { fromBase64Url, reactMessage, toBase64Url } from "@emojery/shared/core";
import type { TargetRef } from "../shared/adapter";
import { defined } from "../shared/defined";
import type { ReactionAction } from "../shared/messages";
import { markReactedOnce } from "../shared/onboarding";
import { randomId } from "../shared/random-id";
import type { Reaction } from "../shared/reactions";
import { getOwnReaction, setOwnReaction } from "../shared/storage";
import { clearAlarm, createAlarm, storageLocalGet, storageLocalSet } from "../shared/webext";
import { type ApiReply, apiErrorString, apiRequest, isRecord } from "./api-client";
import { logBackgroundError } from "./debug";
import { signWithDeviceKey } from "./device-keys";
import { pushHistory, removeHistoryEntry } from "./history";
import { type AuthState, clearAuth, getAuth, getLiveAuth, refreshSession, setAuthOrigin } from "./identity";
import { originIsSigned } from "./origin-switch";
import { broadcastVoteDelta } from "./vote-sync";
import { clearQueuedVotes, getQueueStats, pairKey, peekNextEligible, type StoredVote, settleVote, updateVote, upsertClick } from "./votequeue";

const DEBOUNCE_MS = 250;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 5 * 60_000;
const HOLD_MAX_MS = 5 * 60_000;
const RATE_HOLD_MAX_MS = 60_000;
const ORIGIN_RETRY_MS = 10 * 60_000;
const EXPIRY_MS = 24 * 3_600_000;
const MAX_SENDS_PER_DRAIN = 50;
const FLUSH_STATE_KEY = "vote_flush_state_v2";

export const VOTE_WAKE_ALARM = "vote-flush-wake";
const VOTE_WAKE_PERIOD_MINUTES = 5;

function syncVoteWakeAlarm(queueHasWork: boolean, wakeAt?: number): void {
  if (!queueHasWork) {
    clearAlarm(VOTE_WAKE_ALARM);
    return;
  }
  const when = wakeAt !== undefined && wakeAt > Date.now() ? wakeAt : undefined;
  createAlarm(VOTE_WAKE_ALARM, defined({ when, periodInMinutes: VOTE_WAKE_PERIOD_MINUTES }));
}

function historyActionFor(reaction: Reaction | null, prevReaction: Reaction | null): ReactionAction | undefined {
  if (reaction === null) return prevReaction ? "remove" : undefined;
  return prevReaction ? "change" : "add";
}

/** True once the click is durably queued. False: dropped - the caller answers "error" so the
 *  tab rolls its optimistic reaction back. */
export async function enqueueVote(record: { target: TargetRef; reaction: Reaction | null; prevReaction: Reaction | null; ts: number; lang?: string; title?: string }): Promise<boolean> {
  const auth = await getAuth();
  if (!auth) return false;
  const clicked = record.reaction ?? record.prevReaction;
  const action = historyActionFor(record.reaction, record.prevReaction);
  const optimisticHistoryId = clicked ? randomId() : undefined;
  await upsertClick({
    pair: pairKey(auth.userId, record.target),
    userId: auth.userId,
    ...(auth.enrollHash ? { enrollHash: auth.enrollHash } : {}),
    target: record.target,
    desired: record.reaction,
    prevReaction: record.prevReaction,
    now: record.ts,
    ...(record.title ? { title: record.title } : {}),
    ...(clicked && optimisticHistoryId ? { historyReaction: clicked, optimisticHistoryId } : {}),
    ...(clicked && action ? { historyAction: action } : {}),
  });
  if (clicked && optimisticHistoryId) {
    await pushHistory(auth.userId, record.target, clicked, defined({ historyId: optimisticHistoryId, ts: record.ts, action, title: record.title })).catch((error: unknown) => logBackgroundError("enqueueVote.pushHistory", error));
  }
  syncVoteWakeAlarm(true);
  void scheduleFlush();
  void markReactedOnce().catch((error: unknown) => logBackgroundError("markReactedOnce", error));
  return true;
}

// ---- the queue-wide hold ------------------------------------------------------------------

export interface FlushState {
  /** Epoch-ms before which nothing is sent: the red button, a 503, a rate limit, the daily
   *  budget, an origin switch waiting for its signed record. */
  nextAttemptAt: number;
  consecutiveFailures: number;
  /** Why the queue holds, for the popup's Debug tab and its messages. */
  reason?: string;
}

export async function getFlushState(): Promise<FlushState> {
  const stored = (await storageLocalGet([FLUSH_STATE_KEY]))[FLUSH_STATE_KEY] as Partial<FlushState> | undefined;
  if (!stored || typeof stored.nextAttemptAt !== "number" || typeof stored.consecutiveFailures !== "number") return { nextAttemptAt: 0, consecutiveFailures: 0 };
  return stored as FlushState;
}

async function holdQueue(ms: number, reason: string): Promise<void> {
  const state = await getFlushState();
  await storageLocalSet({ [FLUSH_STATE_KEY]: { nextAttemptAt: Date.now() + ms, consecutiveFailures: state.consecutiveFailures + 1, reason } satisfies FlushState });
}

async function clearHold(): Promise<void> {
  await storageLocalSet({ [FLUSH_STATE_KEY]: { nextAttemptAt: 0, consecutiveFailures: 0 } satisfies FlushState });
}

export function retryDelayMs(attempts: number, random: () => number = Math.random): number {
  const exp = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, attempts - 1));
  return Math.max(RETRY_MIN_MS, Math.floor(exp + exp * 0.25 * (random() * 2 - 1)));
}

const retryAfterMs = (reply: ApiReply, cap: number, floor = 1_000): number => Math.min(cap, Math.max(floor, (reply.retryAfterSeconds ?? 0) * 1000));

// ---- the drain ----------------------------------------------------------------------------

let flushTimer = 0;
let flushInFlight = false;
let flushRerun = false;

export async function scheduleFlush(): Promise<void> {
  if (flushTimer) return;
  let holdUntil = 0;
  let earliest = 0;
  try {
    holdUntil = (await getFlushState()).nextAttemptAt;
    const stats = await getQueueStats();
    if (stats.count === 0) return;
    earliest = stats.earliestNextAttemptAt ?? 0;
  } catch (error) {
    logBackgroundError("scheduleFlush", error);
  }
  if (flushTimer) return;
  const now = Date.now();
  const delay = Math.max(0, Math.max(now + DEBOUNCE_MS, holdUntil, earliest) - now);
  flushTimer = self.setTimeout(() => {
    flushTimer = 0;
    void flushVotes().catch((error: unknown) => logBackgroundError("flushVotes", error));
  }, delay);
}

export async function flushVotes(): Promise<void> {
  if (flushInFlight) {
    flushRerun = true;
    return;
  }
  flushInFlight = true;
  try {
    do {
      flushRerun = false;
      await drain();
    } while (flushRerun);
  } finally {
    flushInFlight = false;
    try {
      const stats = await getQueueStats();
      const wakeAt = Math.max(stats.earliestNextAttemptAt ?? 0, (await getFlushState()).nextAttemptAt);
      const signedOut = await getAuth()
        .then((a) => a === null)
        .catch(() => false);
      syncVoteWakeAlarm(stats.count > 0 && !signedOut, wakeAt);
    } catch (error) {
      logBackgroundError("flushVotes.syncVoteWakeAlarm", error);
    }
  }
}

/** Sends what this account holds before sign-out, within a few seconds. */
export async function flushOwnedVotesForSignOut(): Promise<void> {
  const auth = await getAuth();
  if (!auth?.enrollHash) return;
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    const before = (await getQueueStats()).count;
    if (before === 0) return;
    await flushVotes();
    if ((await getQueueStats()).count >= before) return;
  }
}

async function drain(): Promise<void> {
  const tried = new Set<number>();
  for (let sends = 0; sends < MAX_SENDS_PER_DRAIN; sends++) {
    const now = Date.now();
    if ((await getFlushState()).nextAttemptAt > now) break;
    const auth = await getLiveAuth();
    // Signed out, or a key still waiting for its registration: the records wait for it.
    if (!auth?.enrollHash || auth.enrollSeq === undefined) break;
    const vote = await peekNextEligible(now, tried);
    if (!vote) break;
    tried.add(vote.id);
    if (vote.userId !== auth.userId || (vote.enrollHash !== undefined && vote.enrollHash !== auth.enrollHash)) {
      // Another account's or another key's record: its pairs belong to that account.
      await settleVote(vote, null);
      await dropHistory(vote);
      continue;
    }
    if (now - vote.firstQueuedAt > EXPIRY_MS) {
      await rollback(vote);
      continue;
    }
    const stamped: StoredVote = { ...vote, enrollHash: auth.enrollHash };
    let reply: ApiReply;
    try {
      reply = await send(stamped, auth);
    } catch (error) {
      logBackgroundError("drain.send", error);
      await backOff(stamped);
      continue;
    }
    const next = await handleReply(reply, stamped, auth);
    if (next === "stop") break;
    // Rebuilt, re-signed under a new origin, or sent again on a refreshed session.
    if (next === "again") tried.delete(vote.id);
  }
  try {
    if ((await getQueueStats()).count > 0) void scheduleFlush();
  } catch (error) {
    logBackgroundError("drain.stats", error);
  }
}

async function send(vote: StoredVote, auth: AuthState): Promise<ApiReply> {
  const reaction = vote.desired ?? "";
  const prevReaction = vote.base ?? "";
  const message = reactMessage({ origin: auth.origin, enrollHash: fromBase64Url(auth.enrollHash as string), site: vote.target.site, targetId: vote.target.targetId, reaction, prevReaction, counter: vote.counter });
  const sig = await signWithDeviceKey(auth.provider, message);
  return apiRequest("/v2/react", { method: "POST", token: auth.token, body: { site: vote.target.site, targetId: vote.target.targetId, reaction, prevReaction, counter: vote.counter, sig: toBase64Url(sig) }, keepalive: true });
}

async function backOff(vote: StoredVote, reply?: ApiReply): Promise<void> {
  const attempts = vote.attempts + 1;
  const delay = reply ? Math.max(retryDelayMs(attempts), retryAfterMs(reply, RETRY_MAX_MS, 0)) : retryDelayMs(attempts);
  await updateVote({ ...vote, attempts, nextAttemptAt: Date.now() + delay, ...(reply ? { lastError: `${reply.status} ${apiErrorString(reply.body) ?? ""}`.trim() } : {}) });
}

async function handleReply(reply: ApiReply, vote: StoredVote, auth: AuthState): Promise<"next" | "again" | "stop"> {
  const error = apiErrorString(reply.body);
  if (reply.ok) {
    await settleVote(vote, { pair: vote.pair, reaction: vote.desired, counter: vote.counter });
    await confirmHistory(vote, auth);
    await clearHold();
    return "next";
  }
  switch (reply.status) {
    case 409:
      if (error === "state_conflict" && isRecord(reply.body) && typeof reply.body.counter === "number" && !vote.conflictRebuilt) {
        // Rebuild once from the server's state; a second conflict rolls the click back.
        const base = typeof reply.body.reaction === "string" && reply.body.reaction !== "" ? (reply.body.reaction as Reaction) : null;
        await updateVote({ ...vote, base, counter: reply.body.counter + 1, conflictRebuilt: true, attempts: 0, nextAttemptAt: 0 });
        return "again";
      }
      if (error === "stale_origin" && isRecord(reply.body) && typeof reply.body.origin === "string") {
        if (await originIsSigned(reply.body.origin)) {
          await setAuthOrigin(reply.body.origin);
          return "again";
        }
        await holdQueue(ORIGIN_RETRY_MS, "origin_unverified");
        return "stop";
      }
      await rollback(vote);
      return "next";
    case 401:
      if (error === "session_revoked" && (await refreshSession(auth))) return "again";
      if (error === "account_deleted") {
        await clearQueuedVotes(auth.userId);
        await clearAuth();
      }
      return "stop";
    case 403:
      // A ban (account_restricted), a key the server never enrolled: the click cannot land.
      await rollback(vote);
      if (error === "key_not_enrolled") await clearAuth();
      return error === "account_restricted" ? "next" : "stop";
    case 429:
      await holdQueue(error === "daily_limit" ? retryAfterMs(reply, 24 * 3_600_000) : retryAfterMs(reply, RATE_HOLD_MAX_MS), error ?? "rate_limited");
      return "stop";
    case 503:
      if (error === "key_pending") {
        await holdQueue(retryAfterMs(reply, HOLD_MAX_MS, 15_000), "key_pending");
        return "stop";
      }
      await holdQueue(retryAfterMs(reply, HOLD_MAX_MS, RETRY_MIN_MS), error ?? "unavailable");
      return "stop";
  }
  if (reply.status >= 400 && reply.status < 500) {
    await rollback(vote);
    return "next";
  }
  await backOff(vote, reply);
  return "next";
}

async function confirmHistory(vote: StoredVote, auth: AuthState): Promise<void> {
  if (!vote.historyReaction) return;
  await pushHistory(auth.userId, vote.target, vote.historyReaction, defined({ historyId: vote.optimisticHistoryId, action: vote.historyAction, title: vote.title })).catch((error: unknown) => logBackgroundError("confirmHistory", error));
}

async function dropHistory(vote: StoredVote): Promise<void> {
  if (vote.optimisticHistoryId) await removeHistoryEntry(vote.optimisticHistoryId).catch((error: unknown) => logBackgroundError("dropHistory", error));
}

/** The click did not land: back to what the page showed before it, only where the page still
 *  shows the dropped reaction (a newer click elsewhere wins), and every tab is told. */
async function rollback(vote: StoredVote): Promise<void> {
  await settleVote(vote, null);
  await dropHistory(vote);
  try {
    const shown = await getOwnReaction(vote.target, vote.userId);
    if (shown === vote.desired) await setOwnReaction(vote.target, vote.rollbackTo, vote.userId);
  } catch (error) {
    logBackgroundError("rollback.ownReaction", error);
  }
  void broadcastVoteDelta(undefined, { target: vote.target, reaction: vote.rollbackTo, prevReaction: vote.desired });
}
