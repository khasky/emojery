// SPDX-License-Identifier: GPL-3.0-or-later
//
// Read path: fetch a target's public counts plus the signed-in user's own
// reaction. Kept apart from api.ts (the durable vote-write queue): the read path
// shares only the fetch wrapper, the session and the Retry-After parser with it.

import type { TargetRef } from "../shared/adapter";
import { API_BASE } from "../shared/config";
import type { RuntimeErrorCode } from "../shared/messages";
import type { ReactionCounts, TargetCounts } from "../shared/reactions";
import { DEFAULT_BREAKDOWN_LIMIT } from "../shared/reactions";
import { targetKey } from "../shared/storage";
import { apiFetch, logBackgroundError } from "./debug";
import { clearAuth, extensionClientHeaders, getAuth } from "./identity";
import { normalizeReaction } from "./message-guard";
import { parseRetryAfterSeconds } from "./retry-after";

// A non-ok API response. Carries the status so callers classify the failure from
// a field instead of re-parsing a message string.
export class ApiHttpError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
    this.name = "ApiHttpError";
  }
}

export function apiErrorCode(error: unknown): RuntimeErrorCode {
  if (!(error instanceof ApiHttpError)) return "network";
  if (error.status === 429) return "rate_limited";
  return error.status >= 500 ? "server" : "unavailable";
}

// One retry is all a page read can afford. A `Retry-After` longer than this is
// more than a mounted trigger can wait through, so give up rather than retry late.
const READ_RETRY_MAX_DELAY_MS = 2_000;
const READ_RETRY_DEFAULT_DELAY_MS = 500;

function readRetryDelayMs(res: Response): number | null {
  if (res.status !== 429 && res.status < 500) return null;
  const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get("retry-after"));
  const delayMs = retryAfterSeconds === undefined ? READ_RETRY_DEFAULT_DELAY_MS : retryAfterSeconds * 1000;
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
  /** Drop the window timer without sending; the batch's promise stays pending forever. */
  cancel: () => void;
  reactions: Promise<Record<string, string>>;
}

let pendingMine: MineBatch | null = null;

/** Test seam: the open batch is module state and outlives a test's stubbed fetch.
 *  Cancels the window timer too - an orphaned one still fires a real request. */
export function clearPendingMineBatch(): void {
  pendingMine?.cancel();
  pendingMine = null;
}

function openMineBatch(token: string): MineBatch {
  const targets: TargetRef[] = [];
  let timer = 0;
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
    },
    reactions: gate.then(() => sendMineRequest(token, targets)),
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

// Resolves to a (possibly empty) map, never rejects: a missing own-reaction only
// costs the "you reacted" marker, and the shared promise is awaited by every
// target in the batch - one rejection would surface as that many failures.
async function sendMineRequest(token: string, targets: readonly TargetRef[]): Promise<Record<string, string>> {
  const query = targets.map((target) => `t=${encodeURIComponent(`${target.site}/${target.targetId}`)}`).join("&");
  try {
    // `no-store` for the same reason as the counts read below.
    const res = await apiFetch(`${API_BASE}/reactions/mine?${query}`, {
      method: "GET",
      cache: "no-store",
      headers: { ...extensionClientHeaders(), authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      await clearAuth();
      return {};
    }
    if (!res.ok) return {};
    // `{ reactions: { "<site>:<targetId>": "🤣" } }` - the map is wrapped so
    // the response can grow a field without colliding with a target key.
    // Filtered to the requested targets and to emoji-shaped values rather than
    // trusted from a cast: the shared map is read per target key, so nothing
    // beyond this batch's keys has a reader, and a junk value would otherwise
    // travel into the counts cache as `myReaction`.
    const body: unknown = await res.json();
    const raw = isRecord(body) && isRecord(body.reactions) ? body.reactions : {};
    const reactions: Record<string, string> = {};
    for (const target of targets) {
      const key = `${target.site}:${target.targetId}`;
      const value = normalizeReaction(raw[key]);
      if (value !== null) reactions[key] = value;
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
function parseTargetCounts(raw: unknown, limit: number): TargetCounts {
  if (!isRecord(raw) || !isRecord(raw.counts) || !isCount(raw.total) || !isCount(raw.loaded) || typeof raw.hasMore !== "boolean") {
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
  return { counts, total: raw.total, loaded: raw.loaded, hasMore: raw.hasMore };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function fetchTargetCountsAndOwnReaction(target: TargetRef, limit: number): Promise<TargetCounts> {
  const targetParam = `${target.site}/${target.targetId}`;
  const auth = await getAuth();
  // Both reads use `no-store`: the extension has its own read cache
  // (READ_CACHE_TTL_MS), so letting the browser HTTP layer also cache these could
  // resurface counts the user changed minutes ago.
  const countsP = fetchCountsWithRetry(`${API_BASE}/reactions/count?t=${encodeURIComponent(targetParam)}&limit=${limit}`);
  // `mine` runs concurrently with `count`; a non-ok `count` throws below while
  // it is still in flight, which is safe because the batched read never rejects.
  const mineP = auth ? requestMyReactions(target, auth.token) : null;

  const countsRes = await countsP;
  const base = parseTargetCounts(await countsRes.json(), limit);

  const myReaction = mineP ? ((await mineP)[`${target.site}:${target.targetId}`] ?? null) : null;
  return { ...base, myReaction };
}

// The counts read, retried once on a transient failure (429/5xx). A permanent
// status, an exhausted retry, or a `Retry-After` past the cap rejects with the
// status attached, so the caller can tell "rate limited" from "server down".
async function fetchCountsWithRetry(url: string): Promise<Response> {
  // One init for both attempts, so the retry carries the same client identity
  // headers as the first request.
  const init: RequestInit = { method: "GET", cache: "no-store", headers: extensionClientHeaders() };
  const res = await apiFetch(url, init);
  if (res.ok) return res;
  const retryInMs = readRetryDelayMs(res);
  if (retryInMs === null) throw new ApiHttpError(res.status);
  await new Promise<void>((resolve) => {
    self.setTimeout(resolve, retryInMs);
  });
  const retried = await apiFetch(url, init);
  if (!retried.ok) throw new ApiHttpError(retried.status);
  return retried;
}
