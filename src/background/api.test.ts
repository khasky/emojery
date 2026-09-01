// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, lastFetchCall, stubFetchJson, stubFirefoxDataConsent } from "../test/fixtures";

vi.mock("./votequeue", () => ({
  enqueue: vi.fn().mockResolvedValue(1),
  peekNext: vi.fn(),
  peekNextEligible: vi.fn(),
  getQueueStats: vi.fn().mockResolvedValue({ count: 0 }),
  deleteById: vi.fn(),
  bumpAttempt: vi.fn(),
}));
vi.mock("./identity", () => ({
  getAuth: vi.fn(),
  clearAuth: vi.fn(),
  extensionClientHeaders: () => ({}),
  jsonApiHeaders: async (opts: { token?: string; lang?: string } = {}) => ({
    "content-type": "application/json",
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(opts.lang ? { "accept-language": opts.lang } : {}),
  }),
}));
vi.mock("./history", () => ({
  pushHistory: vi.fn().mockResolvedValue(undefined),
  removeHistoryEntry: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../shared/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../shared/storage")>()),
  clearOwnReactionIfMatches: vi.fn().mockResolvedValue(undefined),
}));

import type { TargetRef } from "../shared/adapter";
import { clearOwnReactionIfMatches } from "../shared/storage";
import { enqueueVote, flushOwnedVotesForSignOut, flushVotes, voteRetryDelayMs } from "./api";
import { ApiHttpError, apiErrorCode, clearFailedReads, clearPendingMineBatch, fetchCount, MINE_BATCH_WINDOW_MS } from "./api-read";
import { pushHistory, removeHistoryEntry } from "./history";
import { getAuth } from "./identity";
import { bumpAttempt, deleteById, enqueue, peekNext, peekNextEligible, type StoredVote } from "./votequeue";

const target: TargetRef = {
  site: "facebook",
  targetId: "1",
  url: "https://www.facebook.com/zuck/posts/1",
};

// One vote as the drain reads it back; each case overrides only what it pins.
function queued(overrides: Partial<StoredVote> = {}): StoredVote {
  return { id: 7, target, reaction: "❤️", ts: 100, attempts: 0, userId: "u1", analyticsConsent: true, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps unconsumed mockResolvedValueOnce entries: a drain that
  // breaks on backoff before emptying its peek queue would leak them here.
  vi.mocked(peekNext).mockReset();
  vi.mocked(peekNextEligible).mockReset();
  // The negative read cache is module state; a failure test would otherwise
  // short-circuit the next test's read of the same target.
  clearFailedReads();
  // Same reason: an open /reactions/mine batch would collect the next test's target.
  clearPendingMineBatch();
  vi.useFakeTimers();
  installFakeChrome();
  vi.stubGlobal("navigator", { language: "uk-UA" });
  vi.mocked(getAuth).mockResolvedValue({
    userId: "u1",
    token: "jwt",
    expiresAt: 9999999999,
  } as Awaited<ReturnType<typeof getAuth>>);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Locks the optimistic-vote ownership contract: the content script computes
// `prevReaction` (ui/vote-client.ts) and the SW only enqueues it - never
// re-derives it. See the unreact case especially.
describe("enqueueVote", () => {
  // The optimistic history row must carry the same generated id the queue entry
  // holds - the flush later confirms or rolls the row back by that id.
  function expectHistoryPushedWithEnqueuedId(reaction: string, action: string): void {
    const { optimisticHistoryId } = vi.mocked(enqueue).mock.calls[0]![0] as { optimisticHistoryId: string };
    expect(pushHistory).toHaveBeenCalledWith("u1", target, reaction, { historyId: optimisticHistoryId, ts: 100, action });
  }

  it("carries the clicked emoji as historyReaction on a fresh react (prevReaction null)", async () => {
    await enqueueVote({ target, reaction: "❤️", prevReaction: null, ts: 100 });
    expect(enqueue).toHaveBeenCalledWith({
      target,
      reaction: "❤️",
      ts: 100,
      attempts: 0,
      userId: "u1",
      analyticsConsent: true,
      lang: "uk-UA",
      historyReaction: "❤️",
      historyAction: "add",
      optimisticHistoryId: expect.any(String),
    });
    expectHistoryPushedWithEnqueuedId("❤️", "add");
  });

  it("carries the new emoji as historyReaction when switching reactions", async () => {
    await enqueueVote({ target, reaction: "❤️", prevReaction: "👍", ts: 100 });
    expect(enqueue).toHaveBeenCalledWith({
      target,
      reaction: "❤️",
      ts: 100,
      attempts: 0,
      userId: "u1",
      analyticsConsent: true,
      lang: "uk-UA",
      historyReaction: "❤️",
      historyAction: "change",
      optimisticHistoryId: expect.any(String),
    });
    expectHistoryPushedWithEnqueuedId("❤️", "change");
  });

  it("carries the removed emoji (not null) as historyReaction when unreacting", async () => {
    await enqueueVote({ target, reaction: null, prevReaction: "👍", ts: 100 });
    expect(enqueue).toHaveBeenCalledWith({
      target,
      reaction: null,
      ts: 100,
      attempts: 0,
      userId: "u1",
      analyticsConsent: true,
      lang: "uk-UA",
      // The toggle-off click still belongs in "Recently Used" - carried as the
      // emoji that was removed, which only works because prevReaction survives.
      historyReaction: "👍",
      historyAction: "remove",
      optimisticHistoryId: expect.any(String),
    });
    expectHistoryPushedWithEnqueuedId("👍", "remove");
  });

  it("stores opt-out on queued votes and omits language fallback", async () => {
    globalThis.chrome.storage.sync.get = vi.fn().mockResolvedValue({
      settings: { analyticsConsent: false },
    });

    await enqueueVote({ target, reaction: "❤️", prevReaction: null, ts: 100 });

    expect(enqueue).toHaveBeenCalledWith({
      target,
      reaction: "❤️",
      ts: 100,
      attempts: 0,
      userId: "u1",
      analyticsConsent: false,
      historyReaction: "❤️",
      historyAction: "add",
      optimisticHistoryId: expect.any(String),
    });
    expectHistoryPushedWithEnqueuedId("❤️", "add");
  });

  it("drops the vote instead of queueing it unowned when signed out", async () => {
    vi.mocked(getAuth).mockResolvedValue(null);
    await enqueueVote({ target, reaction: "❤️", prevReaction: null, ts: 100 });
    expect(enqueue).not.toHaveBeenCalled();
    expect(pushHistory).not.toHaveBeenCalled();
  });

  it("propagates an unreadable session instead of dropping the vote as signed-out", async () => {
    // Absorbing this read swallowed the vote while the click stayed on screen:
    // the caller must be able to answer "error" and roll its optimistic UI back.
    vi.mocked(getAuth).mockRejectedValue(new Error("storage unavailable"));
    await expect(enqueueVote({ target, reaction: "❤️", prevReaction: null, ts: 100 })).rejects.toThrow("storage unavailable");
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("treats denied Firefox technical data consent as analytics opt-out", async () => {
    stubFirefoxDataConsent([]);

    await enqueueVote({
      target,
      reaction: "❤️",
      prevReaction: null,
      ts: 100,
      lang: "en-US",
    });

    expect(enqueue).toHaveBeenCalledWith({
      target,
      reaction: "❤️",
      ts: 100,
      attempts: 0,
      userId: "u1",
      analyticsConsent: false,
      historyReaction: "❤️",
      historyAction: "add",
      optimisticHistoryId: expect.any(String),
    });
  });
});

describe("vote retry backoff", () => {
  it("keeps ten retryable attempts around ten minutes with neutral jitter", () => {
    const delays = Array.from({ length: 9 }, (_, i) => voteRetryDelayMs(i + 1, undefined, () => 0.5));

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 64_000, 128_000, 180_000, 180_000]);
    expect(delays.reduce((sum, delay) => sum + delay, 0)).toBe(614_000);
  });

  it("honors a longer Retry-After header", () => {
    expect(voteRetryDelayMs(1, 90, () => 0.5)).toBe(90_000);
  });
});

describe("flushVotes", () => {
  // Both opt-out paths must emit the same wire shape. One request = one vote:
  // the body is a single vote object, not { votes: [...] }, consent stamped
  // false, no `lang` in the body - the language rides only the header.
  function expectOptOutVoteBody(fetchMock: ReturnType<typeof vi.fn>): void {
    const [, init] = lastFetchCall(fetchMock);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      targetId: target.targetId,
      site: target.site,
      reaction: "❤️",
      ts: 100,
      analyticsConsent: false,
      nonce: "7:100",
    });
    expect(body).not.toHaveProperty("lang");
    expect(init.headers).toMatchObject({ "accept-language": "uk-UA" });
    expect(deleteById).toHaveBeenCalledWith(7);
  }

  it("sends opt-out votes without JSON language fallback", async () => {
    vi.mocked(peekNextEligible)
      .mockResolvedValueOnce(queued({ analyticsConsent: false, lang: "uk-UA" }))
      .mockResolvedValueOnce(undefined);
    const fetchMock = stubFetchJson(200, { accepted: true });

    await flushVotes();

    expectOptOutVoteBody(fetchMock);
  });

  it("re-checks Firefox technical data consent before sending queued opt-in votes", async () => {
    stubFirefoxDataConsent([]);
    vi.mocked(peekNextEligible)
      .mockResolvedValueOnce(queued({ lang: "uk-UA" }))
      .mockResolvedValueOnce(undefined);
    const fetchMock = stubFetchJson(200, { accepted: true });

    await flushVotes();

    expectOptOutVoteBody(fetchMock);
  });

  it("confirms optimistic history when accepted:true is returned", async () => {
    vi.mocked(peekNextEligible)
      .mockResolvedValueOnce(queued({ historyReaction: "❤️", optimisticHistoryId: "hist-7" }))
      .mockResolvedValueOnce(undefined);
    stubFetchJson(200, { accepted: true });

    await flushVotes();

    expect(pushHistory).toHaveBeenCalledWith("u1", target, "❤️", {
      historyId: "hist-7",
      ts: 100,
    });
    expect(removeHistoryEntry).not.toHaveBeenCalled();
    expect(deleteById).toHaveBeenCalledWith(7);
  });

  // What a server-corrected targetId does to the durable record; the rationale
  // for adopting it lives in handleVoteResponse (api.ts).
  describe("server-corrected target key", () => {
    const queuedVote = queued({ historyReaction: "❤️", optimisticHistoryId: "hist-7" });

    it("writes history under the server's targetId and drops the wrongly-keyed optimistic row", async () => {
      vi.mocked(peekNextEligible).mockResolvedValueOnce(queuedVote).mockResolvedValueOnce(undefined);
      stubFetchJson(200, { accepted: true, targetId: "server-key" });

      await flushVotes();

      expect(removeHistoryEntry).toHaveBeenCalledWith("hist-7");
      expect(pushHistory).toHaveBeenCalledWith("u1", { ...target, targetId: "server-key" }, "❤️", { ts: 100 });
    });

    it("keeps the optimistic row when the server agrees with our key", async () => {
      vi.mocked(peekNextEligible).mockResolvedValueOnce(queuedVote).mockResolvedValueOnce(undefined);
      stubFetchJson(200, { accepted: true, targetId: target.targetId });

      await flushVotes();

      expect(removeHistoryEntry).not.toHaveBeenCalled();
      expect(pushHistory).toHaveBeenCalledWith("u1", target, "❤️", { historyId: "hist-7", ts: 100 });
    });

    it("keeps our key when an older build answers without the field", async () => {
      vi.mocked(peekNextEligible).mockResolvedValueOnce(queuedVote).mockResolvedValueOnce(undefined);
      stubFetchJson(200, { accepted: true });

      await flushVotes();

      expect(removeHistoryEntry).not.toHaveBeenCalled();
      expect(pushHistory).toHaveBeenCalledWith("u1", target, "❤️", { historyId: "hist-7", ts: 100 });
    });
  });

  it("drops a queued vote from a different account instead of submitting it", async () => {
    // The first account signs out with this vote still pending; a second signs in before the
    // flush runs. Submitting it now would record it as the second account's vote.
    vi.mocked(peekNextEligible)
      .mockResolvedValueOnce(queued({ id: 11, userId: "u-old", historyReaction: "❤️", optimisticHistoryId: "hist-11" }))
      .mockResolvedValueOnce(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await flushVotes();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(pushHistory).not.toHaveBeenCalled();
    expect(removeHistoryEntry).toHaveBeenCalledWith("hist-11");
    // The dropped vote's own-reaction is cleared for ITS owner, not for u1.
    expect(clearOwnReactionIfMatches).toHaveBeenCalledWith(target, "❤️", "u-old");
    expect(deleteById).toHaveBeenCalledWith(11);
  });

  it("drops pre-stamp legacy entries that carry no owner", async () => {
    const legacyVote = queued({ id: 12 });
    delete legacyVote.userId; // pre-stamp rows carry no owner at all
    vi.mocked(peekNextEligible).mockResolvedValueOnce(legacyVote).mockResolvedValueOnce(undefined);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await flushVotes();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(clearOwnReactionIfMatches).not.toHaveBeenCalled();
    expect(deleteById).toHaveBeenCalledWith(12);
  });

  it("writes history for queued votes without an optimistic history id", async () => {
    vi.mocked(peekNextEligible)
      .mockResolvedValueOnce(queued({ historyReaction: "❤️" }))
      .mockResolvedValueOnce(undefined);
    stubFetchJson(200, { accepted: true });

    await flushVotes();

    expect(pushHistory).toHaveBeenCalledWith("u1", target, "❤️", undefined);
    expect(deleteById).toHaveBeenCalledWith(7);
  });

  it("keeps optimistic history when a re-sent vote comes back accepted:false", async () => {
    // Regression: a re-sent vote whose response was lost comes back accepted:false, and the
    // handler deleted its history row; the accepted:false rationale lives in handleVoteResponse (api.ts).
    vi.mocked(peekNextEligible)
      .mockResolvedValueOnce(queued({ id: 8, attempts: 1, historyReaction: "❤️", optimisticHistoryId: "hist-8" }))
      .mockResolvedValueOnce(undefined);
    stubFetchJson(200, { accepted: false });

    await flushVotes();

    expect(pushHistory).toHaveBeenCalledWith("u1", target, "❤️", { historyId: "hist-8", ts: 100 });
    expect(removeHistoryEntry).not.toHaveBeenCalled();
    expect(clearOwnReactionIfMatches).not.toHaveBeenCalled();
    // Still terminal - dropped so it can't retry forever.
    expect(deleteById).toHaveBeenCalledWith(8);
  });

  it("drains one at a time: a second flush racing an in-flight one never double-submits the head vote", async () => {
    // Regression: scheduleFlush() clears its timer before the async drain finishes,
    // so a concurrent flushVotes() peeked the SAME head vote and POSTed it twice
    // under one nonce. The duplicate returns accepted:false, whose handler dropped
    // the optimistic history / own-reaction the accepted send had just recorded.
    vi.mocked(peekNextEligible)
      .mockResolvedValueOnce(queued({ id: 9, historyReaction: "❤️", optimisticHistoryId: "hist-9" }))
      .mockResolvedValue(undefined);
    let releaseFetch: () => void = () => {};
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await fetchGate;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = flushVotes();
    const second = flushVotes(); // races while `first` is mid-send
    releaseFetch();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deleteById).toHaveBeenCalledTimes(1);
    // The accepted send's optimistic history must survive - there is no rejected
    // duplicate to drop it.
    expect(removeHistoryEntry).not.toHaveBeenCalled();
    expect(clearOwnReactionIfMatches).not.toHaveBeenCalled();
  });

  it("runs one more drain lap when a flush lands mid-drain instead of dropping it", async () => {
    // Regression: the in-flight guard used to swallow a flush whose timer fired
    // during an active drain - nothing re-armed, and the vote enqueued mid-drain
    // waited for the periodic wake alarm (VOTE_WAKE_PERIOD_MINUTES).
    const voteA = { id: 1, target, reaction: "❤️" as const, ts: 100, attempts: 0, userId: "u1" };
    const voteB = { id: 2, target, reaction: "👍" as const, ts: 200, attempts: 0, userId: "u1" };
    vi.mocked(peekNextEligible).mockResolvedValueOnce(voteA).mockResolvedValueOnce(undefined).mockResolvedValueOnce(voteB).mockResolvedValue(undefined);
    let releaseFetch: () => void = () => {};
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) await fetchGate;
      return new Response(JSON.stringify({ accepted: true }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const first = flushVotes();
    const second = flushVotes(); // voteB's flush arrives while voteA is mid-send
    releaseFetch();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deleteById).toHaveBeenCalledWith(1);
    expect(deleteById).toHaveBeenCalledWith(2);
  });

  it("keeps optimistic history on a 5xx while the vote waits for retry", async () => {
    vi.mocked(peekNextEligible)
      .mockResolvedValueOnce(queued({ id: 9, historyReaction: "❤️", optimisticHistoryId: "hist-9" }))
      .mockResolvedValueOnce(undefined);
    stubFetchJson(503);

    await flushVotes();

    expect(pushHistory).not.toHaveBeenCalled();
    expect(removeHistoryEntry).not.toHaveBeenCalled();
    expect(deleteById).not.toHaveBeenCalled();
    // The failure backs off THIS vote (per-vote nextAttemptAt), not just the
    // global flush state - so the rest of the queue stays eligible behind it.
    expect(bumpAttempt).toHaveBeenCalledWith(9, expect.any(Number));
  });
});

describe("flushOwnedVotesForSignOut", () => {
  it("sends the signed-in account's queued vote before the session ends", async () => {
    vi.mocked(peekNext).mockResolvedValueOnce({ id: 7, target, reaction: "❤️", ts: 100, attempts: 0, userId: "u1" }).mockResolvedValue(undefined);
    vi.mocked(peekNextEligible).mockResolvedValueOnce({ id: 7, target, reaction: "❤️", ts: 100, attempts: 0, userId: "u1" }).mockResolvedValue(undefined);
    const fetchMock = stubFetchJson(200, { accepted: true });

    await flushOwnedVotesForSignOut();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deleteById).toHaveBeenCalledWith(7);
  });

  it("leaves a vote owned by a different account untouched", async () => {
    vi.mocked(peekNext).mockResolvedValue({ id: 11, target, reaction: "❤️", ts: 100, attempts: 0, userId: "u-old" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await flushOwnedVotesForSignOut();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(deleteById).not.toHaveBeenCalled();
  });
});

describe("fetchCount", () => {
  it("anonymous: one GET to /reactions/count, no /reactions/mine", async () => {
    vi.mocked(getAuth).mockResolvedValue(null);
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ counts: { "👍": 3 }, total: 3, loaded: 1, hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchCount(target, 6);

    expect(data).toMatchObject({ counts: { "👍": 3 }, total: 3, myReaction: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toContain("/reactions/count?t=");
    expect(url).not.toContain("/reactions/mine");
    // Reads bypass the browser HTTP cache so a stale response can't resurface
    // counts the user already changed.
    const [, init] = lastFetchCall(fetchMock);
    expect(init.cache).toBe("no-store");
  });

  // Every authed count read fans out to /reactions/mine AND the count endpoint. Only the two
  // response bodies differ per case, so the routing lives here once and each case below
  // states just its payloads.
  const stubMineAndCount = (reactions: Record<string, unknown>, counts: object) => vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/reactions/mine") ? { reactions } : counts), { status: 200 }));

  it("authed: merges myReaction from /reactions/mine", async () => {
    vi.mocked(getAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const key = `${target.site}:${target.targetId}`;
    const fetchMock = stubMineAndCount({ [key]: "❤️" }, { counts: { "❤️": 1 }, total: 1, loaded: 1, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    const data = await read;

    expect(data.myReaction).toBe("❤️");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collects the own-reaction reads of one mount burst into a single /reactions/mine", async () => {
    // A feed mounts a screenful of triggers at once; /reactions/mine answers for
    // every target in one call, so the burst must not spend one request per trigger.
    vi.mocked(getAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const second: TargetRef = { ...target, targetId: "2", url: "https://www.facebook.com/zuck/posts/2" };
    const fetchMock = stubMineAndCount({ [`${target.site}:1`]: "❤️", [`${target.site}:2`]: "🔥" }, { counts: {}, total: 0, loaded: 0, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    const reads = Promise.all([fetchCount(target, 6), fetchCount(second, 6)]);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    const [first, other] = await reads;

    expect(first?.myReaction).toBe("❤️");
    expect(other?.myReaction).toBe("🔥");
    const mineCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/reactions/mine"));
    expect(mineCalls).toHaveLength(1);
    expect(mineCalls[0]?.[0]).toContain("t=facebook%2F1&t=facebook%2F2");
  });

  it("dedups concurrent reads of the same target into one request", async () => {
    vi.mocked(getAuth).mockResolvedValue(null);
    let calls = 0;
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      calls++;
      return new Response(JSON.stringify({ counts: {}, total: 0, loaded: 0, hasMore: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([fetchCount(target, 6), fetchCount(target, 6)]);

    expect(calls).toBe(1);
    expect(a).toEqual(b);
  });

  it("bypasses the browser cache on BOTH the count and mine reads (no-store)", async () => {
    vi.mocked(getAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const key = `${target.site}:${target.targetId}`;
    const fetchMock = stubMineAndCount({ [key]: "❤️" }, { counts: { "❤️": 1 }, total: 1, loaded: 1, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    await read;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = (call as unknown as [string, RequestInit])[1];
      expect(init.cache, `${call[0]} must be no-store`).toBe("no-store");
    }
  });

  it("holds the counts body to its contract: junk entries dropped, extra fields shed", async () => {
    vi.mocked(getAuth).mockResolvedValue(null);
    const oversized = "x".repeat(33);
    const body = { counts: { "👍": 3, [oversized]: 5, "❤️": -1, "🔥": "9" }, total: 3, loaded: 1, hasMore: false, junk: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

    const data = await fetchCount(target, 6);

    expect(data).toEqual({ counts: { "👍": 3 }, total: 3, loaded: 1, hasMore: false, myReaction: null });
  });

  it("normalizes padded emoji from the response the way the message guard does", async () => {
    vi.mocked(getAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const key = `${target.site}:${target.targetId}`;
    const fetchMock = stubMineAndCount({ [key]: " 👍 " }, { counts: { " ❤️ ": 2 }, total: 2, loaded: 1, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    const data = await read;

    expect(data).toEqual({ counts: { "❤️": 2 }, total: 2, loaded: 1, hasMore: false, myReaction: "👍" });
  });

  it("caps the counts breakdown at the requested limit", async () => {
    vi.mocked(getAuth).mockResolvedValue(null);
    const emojis = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆"];
    const counts = Object.fromEntries(emojis.map((emoji, i) => [emoji, i + 1]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ counts, total: 36, loaded: 8, hasMore: false }), { status: 200 })),
    );

    const data = await fetchCount(target, 6);

    expect(Object.keys(data.counts)).toEqual(emojis.slice(0, 6));
  });

  it("rejects a counts body whose top-level shape breaks the contract", async () => {
    vi.mocked(getAuth).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ counts: [], total: "3" }), { status: 200 })),
    );

    await expect(fetchCount(target, 6)).rejects.toThrow("malformed counts response");
  });

  it("drops a junk own-reaction value instead of surfacing it as myReaction", async () => {
    vi.mocked(getAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const key = `${target.site}:${target.targetId}`;
    const fetchMock = stubMineAndCount({ [key]: 42, "facebook:unrequested": "🔥" }, { counts: {}, total: 0, loaded: 0, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    const data = await read;

    expect(data.myReaction).toBeNull();
  });

  it("rejects a non-ok count read instead of resolving a stale body", async () => {
    // A non-ok /count surfaces as a failed read, never a silently-served stale
    // (long-removed reactions resurfacing). `Retry-After` past the retry cap
    // means the server wants a longer pause than a page read can wait for, so
    // this rejects on the first response instead of coming back early.
    vi.mocked(getAuth).mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "600" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCount(target, 6)).rejects.toThrow("http 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient count read once and resolves the retry's body", async () => {
    vi.mocked(getAuth).mockResolvedValue(null);
    let attempt = 0;
    const fetchMock = vi.fn(async () => {
      attempt++;
      if (attempt === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ counts: { "👍": 2 }, total: 2, loaded: 1, hasMore: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(500);

    await expect(read).resolves.toMatchObject({ total: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not re-fetch a target whose read just failed (negative cache)", async () => {
    // Outage behavior: feed rescans re-request every visible target; a failed
    // read must short-circuit for its TTL instead of hammering a shedding server.
    vi.mocked(getAuth).mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response("nope", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCount(target, 6)).rejects.toThrow("http 404");
    await expect(fetchCount(target, 6)).rejects.toThrow("http 404");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a rejected read so the popup can tell rate-limited from offline", async () => {
    expect(apiErrorCode(new ApiHttpError(429))).toBe("rate_limited");
    expect(apiErrorCode(new ApiHttpError(503))).toBe("server");
    expect(apiErrorCode(new ApiHttpError(404))).toBe("unavailable");
    expect(apiErrorCode(new TypeError("Failed to fetch"))).toBe("network");
  });

  it("sends nothing more after clearPendingMineBatch: the reset cancels the open batch's timer", async () => {
    // Real timers on purpose - the orphaned setTimeout is the whole point, and a
    // fake clock that afterEach discards would never let it fire.
    vi.useRealTimers();
    vi.mocked(getAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    // Its own target: this read stays pending forever (its batch never releases), so
    // it must not sit in the in-flight map under a key another test reads.
    const orphan: TargetRef = { ...target, targetId: "orphan", url: "https://www.facebook.com/zuck/posts/9" };
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ counts: {}, total: 0, loaded: 0, hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    void fetchCount(orphan, 6);
    // The count read going out means the /reactions/mine batch is open behind it
    // (fetchTargetCountsAndOwnReaction starts both in the same tick). Poll every
    // 1ms, not waitFor's default 50ms: the batch window is 25ms, so a slower poll
    // lets it flush on its own and the reset under test is never exercised.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { interval: 1, timeout: 1_000 });
    clearPendingMineBatch();
    await new Promise((resolve) => setTimeout(resolve, MINE_BATCH_WINDOW_MS * 4));

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/reactions/mine"))).toHaveLength(0);
  });
});
