// SPDX-License-Identifier: GPL-3.0-or-later
//
// The one rule for "the user changed their reaction from `prev` to `next`",
// applied to the public breakdown, to the running total, and to the aggregate
// that carries both.
//
// It lives here because three layers must agree on it: the picker updates the
// counts it is painting (ui/picker.tsx), the content script writes the same
// change into the read-through cache (shared/counts-cache.ts
// applyOptimisticReaction), and a deferred hydration re-applies a click that
// landed while the server read was in flight (ui/mount-counts.ts). When two of
// them drifted, the trigger showed one number and a re-mount read back another.

import type { AggregateCounts, Reaction, ReactionCounts } from "./reactions";

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

// The same move on a whole aggregate. `loaded` follows the breakdown it now
// holds; `hasMore` is the server's word on the page it sent and stays as is.
// Never mutates the input.
export function applyReactionTransition(aggregate: AggregateCounts, prev: Reaction | null, next: Reaction | null): AggregateCounts {
  const counts = applyCountsDelta(aggregate.counts, prev, next);
  return { counts, total: applyTotalDelta(aggregate.total, prev, next), loaded: Object.keys(counts).length, hasMore: aggregate.hasMore };
}
