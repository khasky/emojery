// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sending the vote queue against a fake API: each record built and signed at send time over
// the log's origin and the key's enroll_hash, and the answer table - accepted, rebuilt after a
// conflict, re-signed under a signed new origin, refreshed, held, backed off, rolled back.
// The queue is an in-memory stand-in with votequeue.ts's semantics; its IndexedDB form is
// votequeue.browser.test.ts's.
import { fromBase64Url, reactMessage, toBase64Url } from "@emojery/shared/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetRef } from "../shared/adapter";
import { installFakeChrome } from "../test/fixtures";
import type { KnownPair, QueuedVote, StoredVote } from "./votequeue";

const LOG = "log-staging.emojery.app";
const EH = toBase64Url(new Uint8Array(32).fill(9));

// ---- the queue, in memory --------------------------------------------------------------
const q = vi.hoisted(() => ({ rows: new Map<number, unknown>(), known: new Map<string, unknown>(), nextId: 1 }));
vi.mock("./votequeue", () => ({
  pairKey: (userId: string, t: { site: string; targetId: string }) => `${userId}|${t.site}|${t.targetId}`,
  upsertClick: async (click: QueuedVote & { now: number; prevReaction: string | null }) => {
    const cur = [...q.rows.values()].find((r) => (r as StoredVote).pair === click.pair) as StoredVote | undefined;
    const k = q.known.get(click.pair) as KnownPair | undefined;
    const { now, prevReaction, ...fields } = click;
    const id = cur?.id ?? q.nextId++;
    const row: StoredVote = { ...fields, id, base: cur ? cur.base : k ? k.reaction : prevReaction, counter: Math.max(cur?.counter ?? 0, k?.counter ?? 0) + 1, attempts: 0, firstQueuedAt: cur?.firstQueuedAt ?? now, rollbackTo: cur ? cur.rollbackTo : prevReaction };
    q.rows.set(id, row);
    return row;
  },
  peekNextEligible: async (now: number, skip: Set<number> = new Set()) => [...q.rows.values()].find((r) => ((r as StoredVote).nextAttemptAt ?? 0) <= now && !skip.has((r as StoredVote).id)),
  getQueueStats: async () => ({ count: q.rows.size }),
  updateVote: async (v: StoredVote) => {
    const cur = q.rows.get(v.id) as StoredVote | undefined;
    if (cur && cur.counter <= v.counter) q.rows.set(v.id, v);
  },
  settleVote: async (v: StoredVote, confirmed: KnownPair | null) => {
    const cur = q.rows.get(v.id) as StoredVote | undefined;
    if (cur && cur.counter === v.counter) q.rows.delete(v.id);
    if (confirmed) q.known.set(confirmed.pair, confirmed);
  },
  clearQueuedVotes: async () => {
    q.rows.clear();
  },
}));

// ---- the session and the device key --------------------------------------------------
const session = vi.hoisted(() => ({ auth: null as Record<string, unknown> | null, key: null as CryptoKeyPair | null }));
const refreshSession = vi.fn(async () => true);
const setAuthOrigin = vi.fn(async (origin: string) => {
  if (session.auth) session.auth.origin = origin;
});
vi.mock("./identity", () => ({
  getAuth: async () => session.auth,
  getLiveAuth: async () => session.auth,
  clearAuth: async () => {
    session.auth = null;
  },
  refreshSession: () => refreshSession(),
  setAuthOrigin: (o: string) => setAuthOrigin(o),
}));
vi.mock("./device-keys", () => ({
  signWithDeviceKey: async (_p: string, m: Uint8Array) => new Uint8Array(await crypto.subtle.sign("Ed25519", (session.key as CryptoKeyPair).privateKey, m as BufferSource)),
}));
const originIsSigned = vi.fn(async (_o: string) => true);
vi.mock("./origin-switch", () => ({ originIsSigned: (o: string) => originIsSigned(o) }));
const pushHistory = vi.fn(async () => {});
const removeHistoryEntry = vi.fn(async () => {});
vi.mock("./history", () => ({ pushHistory: (...a: unknown[]) => pushHistory(...(a as [])), removeHistoryEntry: (...a: unknown[]) => removeHistoryEntry(...(a as [])) }));
const broadcastVoteDelta = vi.fn(async () => {});
vi.mock("./vote-sync", () => ({ broadcastVoteDelta: (...a: unknown[]) => broadcastVoteDelta(...(a as [])) }));
const own = vi.hoisted(() => new Map<string, string | null>());
vi.mock("../shared/storage", () => ({
  getOwnReaction: async (t: { targetId: string }) => own.get(t.targetId) ?? null,
  setOwnReaction: async (t: { targetId: string }, r: string | null) => void own.set(t.targetId, r),
}));
vi.mock("../shared/onboarding", () => ({ markReactedOnce: async () => {} }));

const { enqueueVote, flushVotes, getFlushState } = await import("./api");

const target: TargetRef = { site: "github", targetId: "khasky/emojery", url: "https://github.com/khasky/emojery" };

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: Date.UTC(2026, 9, 24) });
  installFakeChrome();
  Object.assign(globalThis.chrome, { alarms: { create: vi.fn(), clear: vi.fn() } });
  q.rows.clear();
  q.known.clear();
  own.clear();
  session.key = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  session.auth = { userId: "test:pk", token: "tok", expiresAt: 2_000_000_000, provider: "test", pk: "pk", enrollHash: EH, enrollSeq: 7, origin: `${LOG}/g0` };
  for (const f of [refreshSession, setAuthOrigin, originIsSigned, pushHistory, removeHistoryEntry, broadcastVoteDelta]) f.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };
function api(replies: Reply[]): { calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      const r = replies.shift() ?? { status: 200 };
      return new Response(r.body === undefined ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers ?? {} });
    }),
  );
  return { calls };
}

async function signedOver(body: Record<string, unknown>, origin: string): Promise<boolean> {
  const message = reactMessage({ origin, enrollHash: fromBase64Url(EH), site: body.site as string, targetId: body.targetId as string, reaction: body.reaction as string, prevReaction: body.prevReaction as string, counter: body.counter as number });
  return crypto.subtle.verify("Ed25519", (session.key as CryptoKeyPair).publicKey, fromBase64Url(body.sig as string) as BufferSource, message as BufferSource);
}

const click = (reaction: string | null, prevReaction: string | null) => enqueueVote({ target, reaction, prevReaction, ts: Date.now() });

describe("the vote queue's send", () => {
  it("signs the pair's desired state over the current origin and the key's enroll_hash, then settles it", async () => {
    const { calls } = api([{ status: 200 }]);
    expect(await click("👍", null)).toBe(true);
    await flushVotes();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ site: "github", targetId: "khasky/emojery", reaction: "👍", prevReaction: "", counter: 1 });
    expect(await signedOver(calls[0] as Record<string, unknown>, `${LOG}/g0`)).toBe(true);
    expect(q.rows.size).toBe(0);
    expect(q.known.get("test:pk|github|khasky/emojery")).toEqual({ pair: "test:pk|github|khasky/emojery", reaction: "👍", counter: 1 });
    expect(pushHistory).toHaveBeenCalledTimes(2);
  });

  it("collapses clicks on one pair into one record whose counter passes every earlier one", async () => {
    const { calls } = api([{ status: 200 }]);
    await click("👍", null);
    await click("❤️", "👍");
    await flushVotes();
    expect(calls).toEqual([expect.objectContaining({ reaction: "❤️", prevReaction: "", counter: 2 })]);
  });

  it("holds every record while the key waits for its registration", async () => {
    const { calls } = api([]);
    (session.auth as Record<string, unknown>).enrollHash = undefined;
    (session.auth as Record<string, unknown>).enrollSeq = undefined;
    await click("👍", null);
    await flushVotes();
    expect(calls).toHaveLength(0);
    expect(q.rows.size).toBe(1);
  });

  it("rebuilds once from a state_conflict, and rolls back on a second", async () => {
    const { calls } = api([{ status: 409, body: { error: "state_conflict", reaction: "🔥", counter: 4 } }, { status: 200 }]);
    await click("👍", null);
    await flushVotes();
    expect(calls[1]).toMatchObject({ reaction: "👍", prevReaction: "🔥", counter: 5 });
    expect(q.rows.size).toBe(0);

    own.set("khasky/emojery", "😂");
    api([
      { status: 409, body: { error: "state_conflict", reaction: "🔥", counter: 6 } },
      { status: 409, body: { error: "state_conflict", reaction: "❤️", counter: 9 } },
    ]);
    await click("😂", "👍");
    await flushVotes();
    expect(q.rows.size).toBe(0);
    expect(own.get("khasky/emojery")).toBe("👍");
    expect(broadcastVoteDelta).toHaveBeenCalledWith(undefined, { target, reaction: "👍", prevReaction: "😂" });
  });

  it("re-signs under a new origin only when the log's index carries its signed record", async () => {
    const { calls } = api([{ status: 409, body: { error: "stale_origin", origin: `${LOG}/g1` } }, { status: 200 }]);
    await click("👍", null);
    await flushVotes();
    expect(originIsSigned).toHaveBeenCalledWith(`${LOG}/g1`);
    expect(await signedOver(calls[1] as Record<string, unknown>, `${LOG}/g1`)).toBe(true);

    originIsSigned.mockResolvedValueOnce(false);
    api([{ status: 409, body: { error: "stale_origin", origin: `${LOG}/g2` } }]);
    await click("❤️", "👍");
    await flushVotes();
    expect(q.rows.size).toBe(1);
    expect((await getFlushState()).reason).toBe("origin_unverified");
  });

  it("refreshes a revoked session and sends again", async () => {
    const { calls } = api([{ status: 401, body: { error: "session_revoked" } }, { status: 200 }]);
    await click("👍", null);
    await flushVotes();
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(2);
    expect(q.rows.size).toBe(0);
  });

  it("holds the whole queue on the daily budget, the red button and a pending key", async () => {
    for (const [reply, reason] of [
      [{ status: 429, body: { error: "daily_limit" }, headers: { "retry-after": "3600" } }, "daily_limit"],
      [{ status: 503, body: { error: "reactions_unavailable" } }, "reactions_unavailable"],
      [{ status: 503, body: { error: "key_pending" }, headers: { "retry-after": "15" } }, "key_pending"],
    ] as const) {
      api([reply]);
      await click("👍", null);
      await flushVotes();
      const hold = await getFlushState();
      expect(hold.reason).toBe(reason);
      expect(hold.nextAttemptAt).toBeGreaterThan(Date.now());
      expect(q.rows.size).toBe(1);
      vi.setSystemTime(hold.nextAttemptAt + 1);
    }
  });

  it("backs one record off on a 5xx without holding the others", async () => {
    api([{ status: 500 }]);
    await click("👍", null);
    await flushVotes();
    const row = [...q.rows.values()][0] as StoredVote;
    expect(row.attempts).toBe(1);
    expect(row.nextAttemptAt).toBeGreaterThan(Date.now());
    expect((await getFlushState()).nextAttemptAt).toBe(0);
  });

  it("drops another account's records and rolls back a record older than a day", async () => {
    const { calls } = api([]);
    await click("👍", null);
    (session.auth as Record<string, unknown>).userId = "test:other";
    await flushVotes();
    expect(calls).toHaveLength(0);
    expect(q.rows.size).toBe(0);

    (session.auth as Record<string, unknown>).userId = "test:pk";
    own.set("khasky/emojery", "👍");
    await click("👍", null);
    vi.setSystemTime(Date.now() + 25 * 3_600_000);
    await flushVotes();
    expect(calls).toHaveLength(0);
    expect(q.rows.size).toBe(0);
    expect(own.get("khasky/emojery")).toBeNull();
  });

  it("refuses a click when no one is signed in", async () => {
    session.auth = null;
    expect(await click("👍", null)).toBe(false);
    expect(q.rows.size).toBe(0);
  });
});
