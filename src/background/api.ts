// SPDX-License-Identifier: GPL-3.0-or-later

import type { TargetRef } from "../shared/adapter";
import { API_BASE } from "../shared/config";
import { effectiveAnalyticsConsent, resolveLocalAnalyticsConsent } from "../shared/data-consent";
import { defined } from "../shared/defined";
import { normalizeLanguageTag } from "../shared/language-tag";
import type { ReactionAction } from "../shared/messages";
import { randomId } from "../shared/random-id";
import type { Reaction } from "../shared/reactions";
import { clearOwnReactionIfMatches } from "../shared/storage";
import { clearAlarm, createAlarm, storageLocalGet, storageLocalSet } from "../shared/webext";
import { apiFetch, logBackgroundError } from "./debug";
import { pushHistory, removeHistoryEntry } from "./history";
import { type AuthState, clearAuth, getAuth, jsonApiHeaders } from "./identity";
import { parseRetryAfterSeconds } from "./retry-after";
import { finishOnboardingBadge } from "./toolbar-badge";
import { bumpAttempt, deleteById, enqueue, getQueueStats, peekNext, peekNextEligible, type QueuedVote, type StoredVote } from "./votequeue";

const VOTE_FLUSH_DEBOUNCE_MS = 250;
const VOTE_FLUSH_MIN_RETRY_MS = 2_000;
const VOTE_FLUSH_MAX_RETRY_MS = 180_000;
const MAX_VOTE_ATTEMPTS = 10;
// The one 4xx retried (server-shaped); any other 4xx is permanent - the payload
// can never get past it.
const HTTP_TOO_MANY_REQUESTS = 429;
// Bounds one drain invocation, not the queue: whatever is left re-arms itself.
const MAX_SENDS_PER_DRAIN = 50;
const FLUSH_STATE_KEY = "vote_flush_state_v1";
const SIGNOUT_FLUSH_MAX_ROUNDS = 20;
const SIGNOUT_FLUSH_BUDGET_MS = 4_000;

// Wakes the service worker to retry a queued vote whose backoff outlives the worker
// itself (up to VOTE_FLUSH_MAX_RETRY_MS, plus the +/-25% jitter voteRetryDelayMs
// applies after the cap). Created only while the queue has work.
export const VOTE_WAKE_ALARM = "vote-flush-wake";
const VOTE_WAKE_PERIOD_MINUTES = 5;

function syncVoteWakeAlarm(queueHasWork: boolean, wakeAt?: number): void {
  if (!queueHasWork) {
    clearAlarm(VOTE_WAKE_ALARM);
    return;
  }
  // `when` wakes the worker at the actual retry time instead of stretching a
  // sub-5-minute backoff to the next periodic tick (the in-worker timer dies
  // with the worker); the period stays on as the safety net after that.
  const when = wakeAt !== undefined && wakeAt > Date.now() ? wakeAt : undefined;
  createAlarm(VOTE_WAKE_ALARM, defined({ when, periodInMinutes: VOTE_WAKE_PERIOD_MINUTES }));
}

let voteFlushTimer = 0;
// scheduleFlush() dedupes only the pending TIMER, so a request during an
// in-flight send would start a second drain and submit the head vote twice under
// one nonce. Keep exactly one drain.
let voteFlushInFlight = false;
// Set when a flush request lands during an active drain; the drain runs one more
// lap instead of dropping it, so a vote enqueued mid-drain does not wait for the
// periodic wake alarm.
let voteFlushRerun = false;

// Classifies the click for the popup's history-row tint. Undefined only for a
// no-op (both null), which never produces a history entry.
function historyActionFor(reaction: Reaction | null, prevReaction: Reaction | null): ReactionAction | undefined {
  if (reaction === null) return prevReaction ? "remove" : undefined;
  return prevReaction ? "change" : "add";
}

/** True once the vote is durably queued. False means it was DROPPED - the caller
 *  must answer "error" so the sending tab rolls its optimistic reaction back.
 *  Rejects instead when the session is unreadable or the queue is full; the
 *  caller answers "error" on that path too, for the same reason. */
export async function enqueueVote(record: { target: TargetRef; reaction: Reaction | null; prevReaction: Reaction | null; ts: number; lang?: string; title?: string }): Promise<boolean> {
  // A vote is bound to the account signed in at click time; signed out between the
  // auth gate and this message, it is dropped rather than queued unowned.
  const auth = await getAuth();
  if (!auth) return false;
  const analyticsConsent = await resolveLocalAnalyticsConsent();
  const lang = analyticsConsent ? (normalizeLanguageTag(record.lang) ?? browserLanguage()) : undefined;
  const clicked = record.reaction ?? record.prevReaction;
  const action = historyActionFor(record.reaction, record.prevReaction);
  const optimisticHistoryId = clicked ? randomId() : undefined;
  await enqueue(
    defined({
      target: record.target,
      reaction: record.reaction,
      ts: record.ts,
      attempts: 0,
      userId: auth.userId,
      analyticsConsent,
      lang,
      title: record.title,
      // Group guard: the three history fields travel together or not at all - an
      // optimistic history id without its reaction is a broken row, not a partial one.
      ...(clicked && optimisticHistoryId ? { historyReaction: clicked, optimisticHistoryId, historyAction: action } : {}),
    }),
  );
  if (clicked && optimisticHistoryId) {
    await pushHistory(auth.userId, record.target, clicked, defined({ historyId: optimisticHistoryId, ts: record.ts, action, title: record.title })).catch((error: unknown) => logBackgroundError("enqueueVote.pushHistory", error));
  }
  // Armed here as well as after a drain: the drain is a debounce away
  // (VOTE_FLUSH_DEBOUNCE_MS) and the worker can be evicted before it runs, which
  // would leave the queued vote with nothing to wake it.
  syncVoteWakeAlarm(true);
  void scheduleFlush();
  // The first ever queued vote retires the fresh-install toolbar dot; a no-op after.
  void finishOnboardingBadge().catch((error: unknown) => logBackgroundError("finishOnboardingBadge", error));
  return true;
}

// Exported for the popup's Debug tab, which renders this hold as the reason a
// queue with work in it is sending nothing.
export interface FlushState {
  /** Epoch-ms when the next flush may run. Gates the whole queue - grown only by
   * server-shaped failures (network down, 429/Retry-After, failures across
   * different votes); a single vote failing repeatedly backs off per-vote. */
  nextAttemptAt: number;
  consecutiveFailures: number;
  /** id of the vote whose failure last touched this state - poison isolation. */
  lastFailedVoteId?: number;
}

export async function getFlushState(): Promise<FlushState> {
  const raw = await storageLocalGet([FLUSH_STATE_KEY]);
  const stored = raw[FLUSH_STATE_KEY] as Partial<FlushState> | undefined;
  if (!stored || typeof stored.nextAttemptAt !== "number" || typeof stored.consecutiveFailures !== "number") {
    return { nextAttemptAt: 0, consecutiveFailures: 0 };
  }
  return stored as FlushState;
}

async function setFlushState(next: FlushState): Promise<void> {
  await storageLocalSet({ [FLUSH_STATE_KEY]: next });
}

export function voteRetryDelayMs(consecutiveFailures: number, retryAfterSec?: number, random: () => number = Math.random): number {
  const failures = Math.max(1, Math.floor(consecutiveFailures));
  const exp = Math.min(VOTE_FLUSH_MAX_RETRY_MS, VOTE_FLUSH_MIN_RETRY_MS * 2 ** (failures - 1));
  const jitter = exp * 0.25 * (random() * 2 - 1);
  let delay = Math.max(VOTE_FLUSH_MIN_RETRY_MS, Math.floor(exp + jitter));
  if (retryAfterSec !== undefined && retryAfterSec > 0) {
    delay = Math.max(delay, retryAfterSec * 1000);
  }
  return delay;
}

// Network-shaped failure (fetch threw): offline applies to every vote, so the
// whole queue backs off.
async function recordVoteRetryBackoff(voteId: number): Promise<void> {
  const state = await getFlushState();
  const consecutiveFailures = state.consecutiveFailures + 1;
  await setFlushState({ nextAttemptAt: Date.now() + voteRetryDelayMs(consecutiveFailures), consecutiveFailures, lastFailedVoteId: voteId });
}

// HTTP retryable failure. A repeated 5xx on the SAME vote is poison-shaped - its
// own per-vote backoff already slows it, so the queue must not inherit the penalty.
// Failures across different votes, or an explicit 429/Retry-After, are server-shaped.
async function recordServerBackoff(voteId: number, status: number, retryAfterSec?: number): Promise<void> {
  const state = await getFlushState();
  const poisonShaped = state.lastFailedVoteId === voteId && status !== HTTP_TOO_MANY_REQUESTS && retryAfterSec === undefined;
  // Poison-shaped: only the owner moves, the hold and the failure count stay put.
  if (poisonShaped) {
    await setFlushState({ ...state, lastFailedVoteId: voteId });
    return;
  }
  const consecutiveFailures = state.consecutiveFailures + 1;
  await setFlushState({ nextAttemptAt: Date.now() + voteRetryDelayMs(consecutiveFailures, retryAfterSec), consecutiveFailures, lastFailedVoteId: voteId });
}

async function recordFlushSuccess(): Promise<void> {
  await setFlushState({ nextAttemptAt: 0, consecutiveFailures: 0 });
}

// Every call site fires this and moves on, so it absorbs its own failures: an
// unreadable backoff state must not become an unhandled rejection in the worker.
// The periodic wake alarm retries whatever this scheduling attempt missed.
export async function scheduleFlush(): Promise<void> {
  if (voteFlushTimer) return;
  let holdUntil = 0;
  let queueEarliest = 0;
  try {
    holdUntil = (await getFlushState()).nextAttemptAt;
    const stats = await getQueueStats();
    if (stats.count === 0) return;
    queueEarliest = stats.earliestNextAttemptAt ?? 0;
  } catch (error) {
    // Falls through with holdUntil 0 and no empty-queue short-circuit: one drain
    // wasted on a possibly-empty queue beats a retry that never gets scheduled.
    logBackgroundError("scheduleFlush", error);
  }
  // Re-check after the awaits above: a concurrent scheduleFlush may have armed
  // the timer while this one was reading state.
  if (voteFlushTimer) return;
  const now = Date.now();
  const earliest = Math.max(now + VOTE_FLUSH_DEBOUNCE_MS, holdUntil, queueEarliest);
  const delay = Math.max(0, earliest - now);
  voteFlushTimer = self.setTimeout(() => {
    voteFlushTimer = 0;
    void flushVotes().catch((error: unknown) => logBackgroundError("flushVotes", error));
  }, delay);
}

export async function flushVotes(): Promise<void> {
  if (voteFlushInFlight) {
    voteFlushRerun = true;
    return;
  }
  voteFlushInFlight = true;
  try {
    do {
      voteFlushRerun = false;
      await drainQueuedVotes();
    } while (voteFlushRerun);
  } finally {
    voteFlushInFlight = false;
    // When to wake next: no attempt can run before both the global hold and the
    // earliest per-vote backoff expire.
    try {
      const stats = await getQueueStats();
      let wakeAt = stats.earliestNextAttemptAt ?? 0;
      try {
        wakeAt = Math.max(wakeAt, (await getFlushState()).nextAttemptAt);
      } catch {
        // Unreadable hold state only costs wake-up precision, not the wake-up.
      }
      syncVoteWakeAlarm(stats.count > 0, wakeAt);
    } catch (error) {
      // Queue unreadable: leave the alarm as it is rather than disarming a pending retry.
      logBackgroundError("flushVotes.syncVoteWakeAlarm", error);
    }
  }
}

// Drain this account's queued votes before sign-out so they land under a valid
// token instead of being dropped later as "ownership changed". Best-effort,
// bounded by drain ROUNDS and a wall-clock budget checked between rounds.
export async function flushOwnedVotesForSignOut(): Promise<void> {
  const auth = await getAuth();
  if (!auth) return;
  const deadline = Date.now() + SIGNOUT_FLUSH_BUDGET_MS;
  for (let i = 0; i < SIGNOUT_FLUSH_MAX_ROUNDS; i++) {
    const head = await peekNext();
    if (!head || head.userId !== auth.userId) return;
    await flushVotes();
    if (Date.now() >= deadline) return;
    const next = await peekNext();
    if (next && next.id === head.id) return; // retryable failure kept the head, leave it to the normal retry
  }
}

async function drainQueuedVotes(): Promise<void> {
  const langHeader = browserLanguage();
  for (let sends = 0; sends < MAX_SENDS_PER_DRAIN; sends++) {
    const now = Date.now();
    let holdUntil = 0;
    try {
      holdUntil = (await getFlushState()).nextAttemptAt;
    } catch (error) {
      logBackgroundError("drainQueuedVotes.getFlushState", error);
    }
    // A queue-wide hold gates every vote; per-vote backoff is baked into
    // eligibility below, so a failing vote no longer blocks the queue behind it.
    if (holdUntil > now) break;
    const vote = await peekNextEligible(now);
    if (!vote) break;

    const auth = await getAuth();
    if (!auth) {
      await dropOptimisticHistory(vote);
      await deleteById(vote.id);
      continue;
    }
    // A queued vote must never be submitted under a different account's token -
    // it would count as that account's vote - so drop it. This also drops
    // pre-stamp legacy entries, which carry no owner.
    if (vote.userId !== auth.userId) {
      await dropOptimisticHistory(vote);
      await deleteById(vote.id);
      continue;
    }

    const analyticsConsent = await effectiveAnalyticsConsent(vote.analyticsConsent !== false);
    const lang = analyticsConsent ? (normalizeLanguageTag(vote.lang) ?? langHeader) : undefined;
    try {
      const res = await apiFetch(`${API_BASE}/reactions/vote`, {
        method: "POST",
        // `accept-language` is the standard request header (live locale), not the consent-gated
        // `lang` analytics field in the body below.
        headers: await jsonApiHeaders(defined({ token: auth.token, lang: langHeader })),
        body: JSON.stringify({
          targetId: vote.target.targetId,
          site: vote.target.site,
          targetUrl: vote.target.url,
          reaction: vote.reaction,
          ts: vote.ts,
          analyticsConsent,
          ...(lang ? { lang } : {}),
          nonce: `${vote.id}:${vote.ts}`,
        }),
        keepalive: true,
      });
      await handleVoteResponse(res, vote, auth);
    } catch (error) {
      // Offline and a bug in the request build land here alike; without the trace a
      // vote that can NEVER succeed looks like a flaky network and the queue drains
      // itself silently.
      logBackgroundError("drainQueuedVotes", error);
      await retryVoteOrDropAfterLimit(vote);
      await recordVoteRetryBackoff(vote.id);
    }
  }
  // Anything left - backed-off votes or an over-cap batch - re-arms its own wake-up.
  try {
    if ((await getQueueStats()).count > 0) void scheduleFlush();
  } catch (error) {
    logBackgroundError("drainQueuedVotes.stats", error);
  }
}

async function handleVoteResponse(res: Response, vote: StoredVote, auth: AuthState): Promise<void> {
  if (!res.ok) {
    if (res.status === 401) {
      await dropOptimisticHistory(vote);
      await clearAuth();
      await deleteById(vote.id);
      await recordFlushSuccess();
      return;
    }
    if (res.status >= 400 && res.status < 500 && res.status !== HTTP_TOO_MANY_REQUESTS) {
      await dropOptimisticHistory(vote);
      await deleteById(vote.id);
      await recordFlushSuccess();
      return;
    }
    const retryAfter = parseRetryAfterSeconds(res.headers.get("retry-after"));
    await retryVoteOrDropAfterLimit(vote, retryAfter);
    await recordServerBackoff(vote.id, res.status, retryAfter);
    return;
  }

  let storedTargetId: string | undefined;
  try {
    const body = (await res.json()) as { targetId?: unknown };
    storedTargetId = typeof body.targetId === "string" && body.targetId.length > 0 ? body.targetId : undefined;
  } catch (error) {
    // Only costs the corrected key below, but a 2xx the client cannot read is a
    // server-contract break worth a trace.
    logBackgroundError("handleVoteResponse.parseBody", error);
  }
  // A 2xx keeps the click's history row whatever `accepted` says: `accepted: false`
  // is a no-op acknowledgement - the reaction is already recorded - so rolling the row
  // back would delete history for a reaction that stands. A refusal arrives as 4xx,
  // which drops the row above. A corrected `targetId` wins for the durable record;
  // the field is optional, so ours stays when it comes back without one.
  const target = storedTargetId && storedTargetId !== vote.target.targetId ? { ...vote.target, targetId: storedTargetId } : vote.target;
  if (vote.historyReaction) {
    // A corrected key cannot reuse the optimistic row (pushHistory's historyId path
    // confirms a duplicate rather than re-targeting it): drop it, add a fresh row keeping
    // the click's ts. The own-reaction entry stays under OUR key - the page's trigger
    // looks it up by the same derivation.
    if (target !== vote.target && vote.optimisticHistoryId) {
      await removeHistoryEntry(vote.optimisticHistoryId).catch((error: unknown) => logBackgroundError("handleVoteResponse.dropStaleKeyedHistory", error));
    }
    const reusableHistoryId = target === vote.target ? vote.optimisticHistoryId : undefined;
    const opts = defined({
      historyId: reusableHistoryId,
      // Guarded on the OPTIMISTIC id, not on `ts` itself: the click's timestamp is
      // carried over only when this row replaces one that was already shown.
      ...(vote.optimisticHistoryId ? { ts: vote.ts } : {}),
      action: vote.historyAction,
      title: vote.title,
    });
    await pushHistory(auth.userId, target, vote.historyReaction, Object.keys(opts).length ? opts : undefined);
  }
  // Delete-after-response: if the service worker is killed between the accepted send
  // (keepalive carries it out) and this delete, the vote is re-queued and re-sent.
  // Safe: a re-sent vote is acknowledged as a no-op, not counted a second time.
  await deleteById(vote.id);
  await recordFlushSuccess();
}

async function retryVoteOrDropAfterLimit(vote: StoredVote, retryAfterSec?: number): Promise<void> {
  const attempts = (vote.attempts ?? 0) + 1;
  if (attempts >= MAX_VOTE_ATTEMPTS) {
    await dropOptimisticHistory(vote);
    await deleteById(vote.id);
    return;
  }
  // The vote backs ITSELF off; the rest of the queue stays eligible.
  await bumpAttempt(vote.id, Date.now() + voteRetryDelayMs(attempts, retryAfterSec));
}

async function dropOptimisticHistory(vote: QueuedVote): Promise<void> {
  if (vote.optimisticHistoryId) {
    await removeHistoryEntry(vote.optimisticHistoryId).catch((error: unknown) => logBackgroundError("dropOptimisticHistory.removeEntry", error));
  }
  // A rejected vote must also drop the durable own-reaction it set, so the trigger stops
  // showing a reaction the server refused. Guarded to the same reaction AND account so a newer
  // own-reaction - or another account's entry - survives; pre-stamp legacy entries carry no
  // owner to clear against.
  if (vote.reaction !== null && vote.userId) {
    await clearOwnReactionIfMatches(vote.target, vote.reaction, vote.userId).catch((error: unknown) => logBackgroundError("dropOptimisticHistory.clearOwnReaction", error));
  }
}

function browserLanguage(): string | undefined {
  return normalizeLanguageTag(typeof navigator !== "undefined" ? navigator.language : undefined);
}
