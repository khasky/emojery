// SPDX-License-Identifier: GPL-3.0-or-later
import type { Reaction, ReactionCounts } from "../shared/reactions";

// Keep the user's selected emoji visible while aggregate counts catch up.
export function deriveOwnReactionDisplay(counts: ReactionCounts, total: number, mine: Reaction | null): { counts: ReactionCounts; total: number } {
  if (mine !== null && (counts[mine] ?? 0) === 0) {
    return { counts: { ...counts, [mine]: 1 }, total: total + 1 };
  }
  return { counts, total };
}

// Rounds to nearest with 1 decimal (picker UI convention) - unlike
// native-compact.ts's compactCountText, which floors to mirror how the
// platforms themselves truncate native counters. The two must stay separate.
// Tier bounds sit at 999,950 (not 1,000,000): toFixed(1) rounds anything above
// them up to "1000.0", which must render as the next tier ("1M", not "1000K").
export function formatCount(n: number): string {
  if (n < 1_000) return String(n);
  if (n < 999_950) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  if (n < 999_950_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}B`;
}
