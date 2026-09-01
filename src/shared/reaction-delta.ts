// SPDX-License-Identifier: GPL-3.0-or-later
//
// The one rule for "the user changed their reaction from `prev` to `next`",
// applied to the public breakdown and to the running total.
//
// It lives here because two layers must agree on it: the picker updates the
// counts it is painting (ui/picker.tsx) while the background writes the same
// change into the read-through cache (shared/counts-cache.ts applyOptimisticReaction).
// When the two derivations drifted, the trigger showed one number and a re-mount
// read back another.

import type { Reaction, ReactionCounts } from "./reactions";

// Never mutates the input.
export function applyCountsDelta(counts: ReactionCounts, prev: Reaction | null, next: Reaction | null): ReactionCounts {
  if (prev === next) return { ...counts };
  const out = { ...counts };
  if (prev) {
    out[prev] = Math.max(0, (out[prev] ?? 0) - 1);
    if (out[prev] === 0) delete out[prev];
  }
  if (next !== null) {
    out[next] = (out[next] ?? 0) + 1;
  }
  return out;
}

// The total counts REACTORS, not reactions: it moves only when one is added or
// removed. Switching from one emoji to another leaves it where it was.
export function applyTotalDelta(total: number, prev: Reaction | null, next: Reaction | null): number {
  if (prev && next === null) return Math.max(0, total - 1);
  if (!prev && next !== null) return total + 1;
  return total;
}
