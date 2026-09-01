// SPDX-License-Identifier: GPL-3.0-or-later
//
// Content-script receiver for cross-tab picker updates.

import type { VoteSyncMessage } from "../shared/messages";
import { dispatchVoteSync } from "./mount-registry";

export function handleVoteSyncMessage(msg: unknown, sender: chrome.runtime.MessageSender, runtimeId: string): boolean {
  if (!isVoteSyncMessage(msg)) return false;
  if (sender.id !== runtimeId) return false;
  dispatchVoteSync({
    target: msg.target,
    reaction: msg.reaction,
    prevReaction: msg.prevReaction,
  });
  return true;
}

function isVoteSyncMessage(msg: unknown): msg is VoteSyncMessage {
  if (!msg || typeof msg !== "object") return false;
  const record = msg as Record<string, unknown>;
  if (record.type !== "voteSync") return false;
  const rawTarget = record.target;
  if (!rawTarget || typeof rawTarget !== "object") return false;
  const target = rawTarget as Record<string, unknown>;
  if (typeof target.site !== "string" || typeof target.targetId !== "string") {
    return false;
  }
  return isReactionOrNull(record.reaction) && isReactionOrNull(record.prevReaction);
}

function isReactionOrNull(value: unknown): boolean {
  return value === null || typeof value === "string";
}
