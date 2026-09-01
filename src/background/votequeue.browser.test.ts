// SPDX-License-Identifier: GPL-3.0-or-later
//
// Vote-queue FIFO semantics against REAL IndexedDB (Vitest browser mode: WebKit and Firefox).
// api.test.ts mocks this store wholesale, so these are the only checks on the real
// cursor/autoincrement behavior the drain loop relies on.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TargetRef } from "../shared/adapter";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { bumpAttempt, deleteById, enqueue, getQueueStats, listQueuedVotes, peekNext, peekNextEligible, type QueuedVote, VOTE_QUEUE_MAX } from "./votequeue";

const target = (n: number): TargetRef => ({ site: "github", targetId: `o/r${n}`, url: `https://github.com/o/r${n}` });

const vote = (n: number, overrides: Partial<QueuedVote> = {}): Omit<QueuedVote, "id"> => ({
  target: target(n),
  reaction: "👍",
  ts: 1_000 + n,
  attempts: 0,
  userId: "user-a",
  ...overrides,
});

// The queue ships no clear(); draining through its own API doubles as coverage.
async function drain(): Promise<void> {
  for (;;) {
    const head = await peekNext();
    if (!head) return;
    await deleteById(head.id);
  }
}

let chromeShim: ChromeShimHandle;
beforeEach(async () => {
  chromeShim = installChromeShim();
  await drain();
});
afterEach(() => chromeShim.uninstall());

describe("vote queue - FIFO on real IndexedDB", () => {
  it("assigns increasing ids and peeks the oldest entry", async () => {
    const a = await enqueue(vote(1));
    const b = await enqueue(vote(2));
    expect(b).toBeGreaterThan(a);
    await expect(peekNext()).resolves.toMatchObject({ id: a, target: target(1) });
  });

  it("keeps the head until deleted, then yields the next in order", async () => {
    const a = await enqueue(vote(1));
    const b = await enqueue(vote(2));
    const c = await enqueue(vote(3));
    await expect(peekNext()).resolves.toMatchObject({ id: a });
    await deleteById(a);
    await expect(peekNext()).resolves.toMatchObject({ id: b });
    await deleteById(b);
    await expect(peekNext()).resolves.toMatchObject({ id: c });
  });

  it("deleteById removes only the addressed row", async () => {
    const a = await enqueue(vote(1));
    const b = await enqueue(vote(2));
    await deleteById(b);
    await expect(peekNext()).resolves.toMatchObject({ id: a });
    await deleteById(a);
    await expect(peekNext()).resolves.toBeUndefined();
  });

  it("bumpAttempt increments in place without reordering the queue", async () => {
    const a = await enqueue(vote(1));
    await enqueue(vote(2));
    await bumpAttempt(a);
    await bumpAttempt(a);
    await expect(peekNext()).resolves.toMatchObject({ id: a, attempts: 2 });
  });

  it("bumpAttempt on a missing id is a no-op", async () => {
    await enqueue(vote(1));
    await expect(bumpAttempt(9_999)).resolves.toBeUndefined();
    await expect(peekNext()).resolves.toMatchObject({ attempts: 0 });
  });

  it("peekNextEligible skips a backed-off head instead of blocking on it", async () => {
    // The head-of-line fix: a failing vote parks itself via nextAttemptAt and
    // the vote behind it drains on time.
    const a = await enqueue(vote(1));
    const b = await enqueue(vote(2));
    await bumpAttempt(a, Date.now() + 60_000);
    await expect(peekNextEligible(Date.now())).resolves.toMatchObject({ id: b });
    // Once its backoff expires the head is eligible again, still oldest-first.
    await expect(peekNextEligible(Date.now() + 61_000)).resolves.toMatchObject({ id: a });
  });

  it("getQueueStats reports count and the earliest per-vote wake-up time", async () => {
    await expect(getQueueStats()).resolves.toEqual({ count: 0 });
    const a = await enqueue(vote(1));
    const b = await enqueue(vote(2));
    const wakeA = Date.now() + 60_000;
    const wakeB = Date.now() + 30_000;
    await bumpAttempt(a, wakeA);
    await bumpAttempt(b, wakeB);
    await expect(getQueueStats()).resolves.toEqual({ count: 2, earliestNextAttemptAt: wakeB });
  });

  it("listQueuedVotes returns the queue oldest-first, capped at the limit", async () => {
    await expect(listQueuedVotes(10)).resolves.toEqual([]);
    const a = await enqueue(vote(1));
    const b = await enqueue(vote(2));
    await enqueue(vote(3));
    await expect(listQueuedVotes(10)).resolves.toMatchObject([{ id: a, target: target(1) }, { id: b }, { target: target(3) }]);
    await expect(listQueuedVotes(2)).resolves.toMatchObject([{ id: a }, { id: b }]);
  });

  it("refuses to grow past VOTE_QUEUE_MAX", { timeout: 60_000 }, async () => {
    // Parallel on purpose: readwrite transactions on one store serialize, so the
    // count-then-add check stays race-safe AND this fills 500 rows in test time.
    const ids = await Promise.all(Array.from({ length: VOTE_QUEUE_MAX }, (_, i) => enqueue(vote(i))));
    await expect(enqueue(vote(VOTE_QUEUE_MAX))).rejects.toThrow("vote queue full");
    await expect(getQueueStats()).resolves.toMatchObject({ count: VOTE_QUEUE_MAX });
    await Promise.all(ids.map((id) => deleteById(id)));
  });

  it("round-trips the full queued payload, unreact included", async () => {
    const full = vote(1, {
      reaction: null,
      historyReaction: "🔥",
      historyAction: "remove",
      optimisticHistoryId: "opt-1",
      analyticsConsent: false,
      lang: "ru",
      title: "queued title",
    });
    await enqueue(full);
    await expect(peekNext()).resolves.toMatchObject(full);
  });
});
