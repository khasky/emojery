// SPDX-License-Identifier: GPL-3.0-or-later
//
// Recently used emojis - a small per-account aggregate (count + last-used per
// emoji) in extension-local storage, never leaving the user's browser. The
// background updates it alongside each history write, so the picker - a content
// script that cannot reach the history IndexedDB - reads a tiny blob instead.

import { storageLocalGet, storageLocalRemove, storageLocalSet } from "./webext";

const RECENTS_KEY = "recents_v1";

interface RecentEmojiStat {
  count: number;
  lastUsed: number;
}

type RecentEmojiStats = Record<string, RecentEmojiStat>;
export type RecentEmojiStatsByUser = Record<string, RecentEmojiStats>;

async function readStatsBlob(): Promise<RecentEmojiStatsByUser> {
  const stored = await storageLocalGet([RECENTS_KEY]);
  return (stored[RECENTS_KEY] as RecentEmojiStatsByUser | undefined) ?? {};
}

// The read-modify-write every mutator below shares. `mutate` returns false to
// leave storage untouched when it changed nothing. A storage failure propagates;
// clearRecentEmojis is the one caller that chooses to swallow it.
// Unlocked, so two overlapping writes can lose one increment: recents is a soft
// quick-access list whose order self-heals on the next reaction, so a lost bump
// is invisible; revisit only if these stats ever feed something exact.
async function updateStats(mutate: (blob: RecentEmojiStatsByUser) => boolean): Promise<void> {
  const blob = await readStatsBlob();
  if (!mutate(blob)) return;
  await storageLocalSet({ [RECENTS_KEY]: blob });
}

// Why every entry point takes the userId as an argument: `storage.local.get` cannot
// project fields, so reading the auth record here would pull its token into the content
// script's heap; the id comes from ui/messaging.ts activeUserId, which also checks expiry.
export async function getRecentEmojis(userId: string, limit: number): Promise<string[]> {
  try {
    const stats = (await readStatsBlob())[userId];
    if (!stats) return [];
    // Most-recent first, with count as a tiebreaker: the just-clicked emoji
    // lands at index 0 even though its count starts at 1.
    return Object.entries(stats)
      .sort((a, b) => b[1].lastUsed - a[1].lastUsed || b[1].count - a[1].count)
      .slice(0, limit)
      .map(([emoji]) => emoji);
  } catch {
    return [];
  }
}

// Drop one account's Recently Used list without touching any reaction history
// or another account's stats; the derived stats repopulate as the user reacts.
// Also the account-deletion path (see background/history.ts clearHistoryForUser).
export async function clearRecentEmojis(userId: string): Promise<void> {
  try {
    await updateStats((blob) => {
      delete blob[userId];
      return true;
    });
  } catch {
    // Storage read/write failed - the list simply isn't cleared. The picker
    // already dropped it optimistically for the current open.
  }
}

export async function bumpRecentEmoji(userId: string, emoji: string, ts: number): Promise<void> {
  await updateStats((blob) => {
    const stats = blob[userId] ?? {};
    blob[userId] = stats;
    const current = stats[emoji];
    stats[emoji] = {
      count: (current?.count ?? 0) + 1,
      lastUsed: Math.max(current?.lastUsed ?? 0, ts),
    };
    return true;
  });
}

// Reverse one bump after an optimistic history row is rolled back or re-homed
// to another account. lastUsed keeps its old stamp - a one-off drift the next
// real reaction overwrites.
export async function dropRecentEmoji(userId: string, emoji: string): Promise<void> {
  await updateStats((blob) => {
    const stats = blob[userId];
    const current = stats?.[emoji];
    if (!stats || !current) return false;
    if (current.count <= 1) delete stats[emoji];
    else stats[emoji] = { count: current.count - 1, lastUsed: current.lastUsed };
    return true;
  });
}

// Merge externally derived stats in (adding counts, keeping the newest
// lastUsed) - used once by the legacy-history migration.
export async function importRecentEmojiStats(statsByUser: RecentEmojiStatsByUser): Promise<void> {
  await updateStats((blob) => {
    for (const [userId, stats] of Object.entries(statsByUser)) {
      const userStats = blob[userId] ?? {};
      blob[userId] = userStats;
      for (const [emoji, stat] of Object.entries(stats)) {
        const current = userStats[emoji];
        userStats[emoji] = {
          count: (current?.count ?? 0) + stat.count,
          lastUsed: Math.max(current?.lastUsed ?? 0, stat.lastUsed),
        };
      }
    }
    return true;
  });
}

export async function clearAllRecentEmojiStats(): Promise<void> {
  await storageLocalRemove([RECENTS_KEY]);
}
