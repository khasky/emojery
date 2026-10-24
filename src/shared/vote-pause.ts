// SPDX-License-Identifier: GPL-3.0-or-later
//
// The vote queue's hold, as the popup reads it: background/api.ts writes it under
// VOTE_FLUSH_STATE_KEY whenever the server holds the account's votes. Only the daily budget
// is something the reader should be told about; the other holds clear by themselves.

import { storageLocalGet } from "./webext";

export const VOTE_FLUSH_STATE_KEY = "vote_flush_state_v2";

export interface DailyLimitPause {
  /** Ms-epoch when voting resumes: midnight UTC. */
  resumesAt: number;
}

export async function readDailyLimitPause(now: number = Date.now()): Promise<DailyLimitPause | null> {
  const state = (await storageLocalGet([VOTE_FLUSH_STATE_KEY]))[VOTE_FLUSH_STATE_KEY] as { nextAttemptAt?: unknown; reason?: unknown } | undefined;
  if (state?.reason !== "daily_limit" || typeof state.nextAttemptAt !== "number" || state.nextAttemptAt <= now) return null;
  return { resumesAt: state.nextAttemptAt };
}
