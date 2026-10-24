// SPDX-License-Identifier: GPL-3.0-or-later
//
// The read path (api-read.ts) against a fake API: public counts at the canonical
// /v2/counts path, the key's own pairs from /v2/mine in one batch per mount burst.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, lastFetchCall } from "../test/fixtures";

vi.mock("./identity", () => ({ getLiveAuth: vi.fn() }));
vi.mock("./votequeue", () => ({
  pairKey: (userId: string, t: { site: string; targetId: string }) => `${userId}|${t.site}|${t.targetId}`,
  rememberPairs: vi.fn(async () => {}),
}));

import type { TargetRef } from "../shared/adapter";
import { REACTION_BYTES_MAX } from "../shared/messages";
import { ApiHttpError, apiErrorCode } from "./api-client";
import { clearFailedReads, clearPendingMineBatch, fetchCount, MINE_BATCH_WINDOW_MS } from "./api-read";
import { getLiveAuth } from "./identity";
import { rememberPairs } from "./votequeue";

const target: TargetRef = {
  site: "x",
  targetId: "1",
  url: "https://x.com/i/status/1",
};

beforeEach(() => {
  vi.clearAllMocks();
  clearFailedReads();
  clearPendingMineBatch();
  vi.useFakeTimers();
  installFakeChrome();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchCount", () => {
  it("anonymous: one GET to /v2/counts, no /v2/mine", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue(null);
    const fetchMock = vi.fn(async (_url: string) => new Response(JSON.stringify({ counts: { "👍": 3 }, total: 3, loaded: 1, hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await fetchCount(target, 6);

    expect(data).toMatchObject({ counts: { "👍": 3 }, total: 3, myReaction: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]![0];
    expect(url).toContain("/v2/counts/");
    expect(url).not.toContain("/v2/mine");
    // Reads bypass the browser HTTP cache so a stale response can't resurface
    // counts the user already changed.
    const [, init] = lastFetchCall(fetchMock);
    expect(init.cache).toBe("no-store");
  });

  // Every authed count read fans out to /v2/mine AND the count endpoint. Only the two
  // response bodies differ per case, so the routing lives here once and each case below
  // states just its payloads.
  const stubMineAndCount = (reactions: Record<string, unknown>, counts: object) => vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/v2/mine") ? { reactions } : counts), { status: 200 }));

  it("authed: merges myReaction from /v2/mine", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    // The wire key is the `site/targetId` token the request sent; `targetKey()` keeps
    // its own `site:targetId` shape for local storage (api-read.ts wireTargetToken).
    const key = `${target.site}/${target.targetId}`;
    const fetchMock = stubMineAndCount({ [key]: { reaction: "❤️", counter: 1, seq: null } }, { counts: { "❤️": 1 }, total: 1, loaded: 1, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    const data = await read;

    expect(data.myReaction).toBe("❤️");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collects the own-reaction reads of one mount burst into a single /v2/mine", async () => {
    // A feed mounts a screenful of triggers at once; /v2/mine answers for
    // every target in one call, so the burst must not spend one request per trigger.
    vi.mocked(getLiveAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const second: TargetRef = { ...target, targetId: "2", url: "https://x.com/i/status/2" };
    const fetchMock = stubMineAndCount({ [`${target.site}/1`]: { reaction: "❤️", counter: 1, seq: 3 }, [`${target.site}/2`]: { reaction: "🔥", counter: 2, seq: null } }, { counts: {}, total: 0, loaded: 0, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    const reads = Promise.all([fetchCount(target, 6), fetchCount(second, 6)]);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    const [first, other] = await reads;

    expect(first?.myReaction).toBe("❤️");
    expect(other?.myReaction).toBe("🔥");
    const mineCalls = fetchMock.mock.calls.filter((call) => String(call[0]).includes("/v2/mine"));
    expect(mineCalls).toHaveLength(1);
    expect(mineCalls[0]?.[0]).toContain("t=x%2F1&t=x%2F2");
  });

  it("dedups concurrent reads of the same target into one request", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue(null);
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
    vi.mocked(getLiveAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const key = `${target.site}/${target.targetId}`;
    const fetchMock = stubMineAndCount({ [key]: { reaction: "❤️", counter: 1, seq: null } }, { counts: { "❤️": 1 }, total: 1, loaded: 1, hasMore: false });
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
    vi.mocked(getLiveAuth).mockResolvedValue(null);
    const oversized = "x".repeat(REACTION_BYTES_MAX + 1);
    const body = { counts: { "👍": 3, [oversized]: 5, "❤️": -1, "🔥": "9" }, total: 3, loaded: 1, hasMore: false, junk: true };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })),
    );

    const data = await fetchCount(target, 6);

    expect(data).toEqual({ counts: { "👍": 3 }, total: 3, loaded: 1, hasMore: false, myReaction: null });
  });

  it("normalizes padded emoji from the response the way the message guard does", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const key = `${target.site}/${target.targetId}`;
    const fetchMock = stubMineAndCount({ [key]: { reaction: " 👍 ", counter: 1, seq: null } }, { counts: { " ❤️ ": 2 }, total: 2, loaded: 1, hasMore: false });
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    const data = await read;

    expect(data).toEqual({ counts: { "❤️": 2 }, total: 2, loaded: 1, hasMore: false, myReaction: "👍" });
  });

  it("caps the counts breakdown at the requested limit", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue(null);
    const emojis = ["😀", "😁", "😂", "🤣", "😃", "😄", "😅", "😆"];
    const counts = Object.fromEntries(emojis.map((emoji, i) => [emoji, i + 1]));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ counts, total: 36, loaded: 8, hasMore: false }), { status: 200 })),
    );

    const data = await fetchCount(target, 6);

    expect(Object.keys(data.counts)).toEqual(emojis.slice(0, 6));
    // `loaded` counts the entries that survived the cap. The response said 8, and a
    // number that disagrees with the map beside it is what nothing reading the field
    // would ever surface.
    expect(data.loaded).toBe(6);
  });

  it("rejects a counts body whose top-level shape breaks the contract", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ counts: [], total: "3" }), { status: 200 })),
    );

    await expect(fetchCount(target, 6)).rejects.toThrow("malformed counts response");
  });

  it("still reads a counts body that omits the two fields nothing renders", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ counts: { "👍": 3 }, total: 3 }), { status: 200 })),
    );

    const data = await fetchCount(target, 6);

    expect(data).toEqual({ counts: { "👍": 3 }, total: 3, loaded: 1, hasMore: false, myReaction: null });
  });

  it("drops a junk own-reaction value instead of surfacing it as myReaction", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const key = `${target.site}/${target.targetId}`;
    const fetchMock = stubMineAndCount({ [key]: { reaction: 42, counter: 1, seq: null }, "x:unrequested": { reaction: "🔥", counter: 1, seq: null } }, { counts: {}, total: 0, loaded: 0, hasMore: false });
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
    vi.mocked(getLiveAuth).mockResolvedValue(null);
    const fetchMock = vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "600" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchCount(target, 6)).rejects.toThrow("http 429");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient count read once and resolves the retry's body", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue(null);
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

  it("spends one deadline across both count attempts, not one per attempt", async () => {
    // The page gives up on the round trip after RUNTIME_MESSAGE_TIMEOUT_MS. A deadline
    // per attempt lets the retry outlast that: an error in the trigger, then counts
    // written for nobody.
    vi.mocked(getLiveAuth).mockResolvedValue(null);
    let attempt = 0;
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => {
      attempt++;
      if (attempt === 1) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ counts: {}, total: 0, loaded: 0, hasMore: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(500);
    await read;

    const [first, second] = fetchMock.mock.calls.map((call) => call[1]?.signal);
    expect(first).toBeInstanceOf(AbortSignal);
    expect(second).toBe(first);
  });

  it("does not re-fetch a target whose read just failed (negative cache)", async () => {
    // Outage behavior: feed rescans re-request every visible target; a failed
    // read must short-circuit for its TTL instead of re-issuing the same failing
    // request once per rebuilt mount.
    vi.mocked(getLiveAuth).mockResolvedValue(null);
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

  it("sends nothing more after clearPendingMineBatch, and settles the read it cancelled", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => new Response(JSON.stringify({ counts: {}, total: 0, loaded: 0, hasMore: false }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const read = fetchCount(target, 6);
    // The count read going out means the /v2/mine batch is open behind it
    // (fetchTargetCountsAndOwnReaction starts both in the same tick). Poll every
    // 1ms, not the waitFor default of 50ms: that overshoots MINE_BATCH_WINDOW_MS, so a slower poll
    // lets it flush on its own and the reset under test is never exercised.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled(), { interval: 1, timeout: 1_000 });
    clearPendingMineBatch();
    // Well past the window: a timer the cancel failed to clear would have fired by now.
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS * 4);

    expect(fetchMock.mock.calls.filter((call) => String(call[0]).includes("/v2/mine"))).toHaveLength(0);
    // A cancelled batch costs the "you reacted" marker and nothing else: the read still
    // settles, frees its slot, and the target stays readable.
    await expect(read).resolves.toMatchObject({ total: 0, myReaction: null });
  });
});

describe("the /v2 read shapes", () => {
  it("reads counts at the canonical path and remembers the pairs /v2/mine reports", async () => {
    vi.mocked(getLiveAuth).mockResolvedValue({ token: "tok", userId: "u" } as never);
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/v2/mine") ? { reactions: { "x/1": { reaction: "", counter: 4, seq: 9 } } } : { counts: { "🔥": 2 }, total: 2 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const read = fetchCount(target, 6);
    await vi.advanceTimersByTimeAsync(MINE_BATCH_WINDOW_MS);
    expect(await read).toEqual({ counts: { "🔥": 2 }, total: 2, loaded: 1, hasMore: false, myReaction: null });
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain("https://api-staging.emojery.app/v2/counts/x/MQ.json");
    expect(rememberPairs).toHaveBeenCalledWith([{ pair: "u|x|1", reaction: null, counter: 4 }]);
  });
});
