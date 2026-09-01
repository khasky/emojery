// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome } from "../test/fixtures";
import type { TargetRef } from "./adapter";
import { READ_CACHE_TTL_MS } from "./config";
import type { CachedTarget } from "./storage";
import {
  applyOptimisticReaction,
  clearAutoNativesForUser,
  clearCountsCache,
  clearOwnReactionIfMatches,
  clearOwnReactionsForUser,
  getAutoNative,
  getCachedCounts,
  getOwnReaction,
  getSettings,
  maybeSweepCountsCache,
  setAutoNative,
  setCachedCounts,
  setOwnReaction,
  setSettings,
  sweepCountsCache,
  targetKey,
} from "./storage";

const target: TargetRef = {
  site: "facebook",
  targetId: "1",
  url: "https://www.facebook.com/zuck/posts/1",
};

function mockCache(prior: Partial<CachedTarget> | null): void {
  const key = `cache:${targetKey(target)}`;
  installFakeChrome({ local: prior ? { [key]: prior } : {} });
}

// The durable own-reaction store's read-modify-write is exercised end-to-end
// against a stateful storage stub, so reads reflect prior writes.
function statefulStorage(initial: Record<string, unknown> = {}): Record<string, unknown> {
  return installFakeChrome({ local: initial }).local;
}

// An empty cache entry aged to `fetchedAt` - the seed every TTL/sweep case varies.
function cacheEntry(fetchedAt: number): CachedTarget {
  return { counts: {}, total: 0, loaded: 0, hasMore: false, myReaction: null, fetchedAt };
}

// Freeze ONLY the clock (not timers): the TTL-boundary fixtures below are built
// relative to `Date.now()`, which must be a constant for `TTL - 1` / `TTL + 1`
// to actually sit on the boundary instead of drifting with the wall clock.
const FROZEN_NOW = Date.UTC(2026, 0, 1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

// The optimistic-counts math + prevReaction: the source of truth for the picker, the cross-tab
// broadcast, and the SW vote.
describe("applyOptimisticReaction", () => {
  it("new reaction: adds the emoji, increments total, prevReaction null", async () => {
    mockCache({
      counts: {},
      total: 0,
      loaded: 0,
      hasMore: false,
      myReaction: null,
      fetchedAt: 0,
    });
    const { next, prevReaction } = await applyOptimisticReaction(target, "❤️", "u1");
    expect(prevReaction).toBeNull();
    expect(next.myReaction).toBe("❤️");
    expect(next.counts["❤️"]).toBe(1);
    expect(next.total).toBe(1);
  });

  it("switch: decrements old, increments new, total unchanged, prevReaction = old", async () => {
    mockCache({
      counts: { "👍": 3 },
      total: 5,
      loaded: 1,
      hasMore: false,
      myReaction: "👍",
      fetchedAt: 0,
    });
    const { next, prevReaction } = await applyOptimisticReaction(target, "❤️", "u1");
    expect(prevReaction).toBe("👍");
    expect(next.counts["👍"]).toBe(2);
    expect(next.counts["❤️"]).toBe(1);
    expect(next.total).toBe(5);
    expect(next.myReaction).toBe("❤️");
  });

  it("unreact: decrements old + total, clears myReaction, prevReaction = old", async () => {
    mockCache({
      counts: { "👍": 3 },
      total: 5,
      loaded: 1,
      hasMore: false,
      myReaction: "👍",
      fetchedAt: 0,
    });
    const { next, prevReaction } = await applyOptimisticReaction(target, null, "u1");
    expect(prevReaction).toBe("👍");
    expect(next.counts["👍"]).toBe(2);
    expect(next.total).toBe(4);
    expect(next.myReaction).toBeNull();
  });
});

// The user's own reaction must survive a re-mount after the counts cache
// expires - but only for the account that set it.
describe("durable own-reaction store", () => {
  it("records the own reaction on a react and reads it back", async () => {
    statefulStorage();
    await applyOptimisticReaction(target, "❤️", "u1");
    expect(await getOwnReaction(target, "u1")).toBe("❤️");
  });

  it("clears the own reaction on an unreact", async () => {
    statefulStorage();
    await applyOptimisticReaction(target, "❤️", "u1");
    await applyOptimisticReaction(target, null, "u1");
    expect(await getOwnReaction(target, "u1")).toBeNull();
  });

  it("returns null for a target the user never reacted to", async () => {
    statefulStorage();
    expect(await getOwnReaction(target, "u1")).toBeNull();
  });

  it("setOwnReaction overwrites and null-deletes", async () => {
    statefulStorage();
    await setOwnReaction(target, "👍", "u1");
    expect(await getOwnReaction(target, "u1")).toBe("👍");
    await setOwnReaction(target, "❤️", "u1");
    expect(await getOwnReaction(target, "u1")).toBe("❤️");
    await setOwnReaction(target, null, "u1");
    expect(await getOwnReaction(target, "u1")).toBeNull();
  });

  it("clearOwnReactionIfMatches only clears the matching reaction", async () => {
    statefulStorage();
    await setOwnReaction(target, "❤️", "u1");
    // A stale rejection for a DIFFERENT (older) reaction must not wipe it.
    await clearOwnReactionIfMatches(target, "👍", "u1");
    expect(await getOwnReaction(target, "u1")).toBe("❤️");
    await clearOwnReactionIfMatches(target, "❤️", "u1");
    expect(await getOwnReaction(target, "u1")).toBeNull();
  });

  // Account switch: sign-out then sign-in as someone else must not inherit the
  // previous account's reaction as "mine" (the store survives sign-out by
  // design - the userId stamp is what scopes it).
  it("never returns another account's reaction", async () => {
    statefulStorage();
    await applyOptimisticReaction(target, "❤️", "u1");
    expect(await getOwnReaction(target, "u2")).toBeNull();
    expect(await getOwnReaction(target, "u1")).toBe("❤️");
  });

  // Collapsing the shared read and the writer's own read back into one function
  // is the regression this pair pins.
  it("shares one storage read across overlapping own-reaction lookups", async () => {
    statefulStorage({ own_reactions_v2: { "facebook:1": { reaction: "❤️", userId: "u1", ts: 1 } } });
    const get = globalThis.chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    get.mockClear();

    const [a, b] = await Promise.all([getOwnReaction(target, "u1"), getOwnReaction(target, "u1")]);

    expect(a).toBe("❤️");
    expect(b).toBe("❤️");
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("gives a concurrent writer its own read, never the shared one", async () => {
    statefulStorage({ own_reactions_v2: { "facebook:1": { reaction: "❤️", userId: "u1", ts: 1 } } });
    const get = globalThis.chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>;
    get.mockClear();

    await Promise.all([getOwnReaction(target, "u1"), setOwnReaction(target, "🔥", "u1")]);

    expect(get).toHaveBeenCalledTimes(2);
    expect(await getOwnReaction(target, "u1")).toBe("🔥");
  });

  // Two mounts on one page vote on DIFFERENT targets in the same tick. Both
  // mutators read-modify-write the SAME whole-map key, so unserialized the second
  // write lands a snapshot taken before the first and silently drops its entry.
  it("keeps both entries when two writers land on different targets at once", async () => {
    statefulStorage();
    const other: TargetRef = { site: "facebook", targetId: "2", url: "https://www.facebook.com/zuck/posts/2" };

    await Promise.all([setOwnReaction(target, "❤️", "u1"), setOwnReaction(other, "🔥", "u1")]);

    expect(await getOwnReaction(target, "u1")).toBe("❤️");
    expect(await getOwnReaction(other, "u1")).toBe("🔥");
  });

  // The write chain must survive a failed mutator, or one unwritable storage call
  // strands every later write behind a rejected promise.
  it("keeps writing after a mutator's storage write fails", async () => {
    const store = statefulStorage();
    const set = globalThis.chrome.storage.local.set as unknown as ReturnType<typeof vi.fn>;
    set.mockImplementationOnce(() => Promise.reject(new Error("quota")));

    await expect(setOwnReaction(target, "❤️", "u1")).rejects.toThrow("quota");
    await setOwnReaction(target, "🔥", "u1");

    expect(store.own_reactions_v2).toEqual({ [targetKey(target)]: { reaction: "🔥", userId: "u1", ts: FROZEN_NOW } });
  });

  it("clearOwnReactionIfMatches leaves another account's entry", async () => {
    statefulStorage();
    await setOwnReaction(target, "❤️", "u1");
    await clearOwnReactionIfMatches(target, "❤️", "u2");
    expect(await getOwnReaction(target, "u1")).toBe("❤️");
  });

  it("an un-react by another account leaves the owner's entry", async () => {
    statefulStorage();
    await setOwnReaction(target, "❤️", "u1");
    await setOwnReaction(target, null, "u2");
    expect(await getOwnReaction(target, "u1")).toBe("❤️");
  });

  it("ignores unowned legacy entries (v1 key and v1-shaped values)", async () => {
    statefulStorage({
      // The pre-scoping store: never read by the v2 code.
      own_reactions_v1: { [targetKey(target)]: "❤️" },
      // A v1-shaped (plain string) value under the v2 key: no owner, no read.
      own_reactions_v2: { [targetKey(target)]: "👍" },
    });
    expect(await getOwnReaction(target, "u1")).toBeNull();
  });

  // An entry from before the timestamps (no `ts`) sorts as epoch 0, so it is
  // evicted before any stamped one.
  it("evicts the oldest entries once a write passes the cap", async () => {
    const now = Date.now();
    const seeded: Record<string, unknown> = { "facebook:legacy": { reaction: "👍", userId: "u1" } };
    for (let i = 0; i < 1000; i++) seeded[`facebook:t${i}`] = { reaction: "👍", userId: "u1", ts: now - i };
    const store = statefulStorage({ own_reactions_v2: seeded });
    const fresh: TargetRef = { site: "facebook", targetId: "fresh", url: "https://www.facebook.com/zuck/posts/2" };

    await setOwnReaction(fresh, "🔥", "u1");

    const map = store.own_reactions_v2 as Record<string, unknown>;
    expect(Object.keys(map)).toHaveLength(1000);
    expect(map["facebook:legacy"]).toBeUndefined(); // ts-less, evicted first
    expect(map["facebook:t999"]).toBeUndefined(); // oldest stamped
    expect(map["facebook:t0"]).toBeDefined(); // newest survivor
    expect(map["facebook:fresh"]).toBeDefined();
  });

  // The cap itself, from both sides. The store is read-modify-written IN FULL on every click,
  // so its size is a per-click cost: an eviction that starts one entry late never shrinks the
  // map, and one that starts early throws away a target the user is still looking at.
  it("holds exactly the cap without evicting, and evicts one the moment it is passed", async () => {
    const now = Date.now();
    const seeded: Record<string, unknown> = {};
    for (let i = 0; i < 999; i++) seeded[`facebook:t${i}`] = { reaction: "👍", userId: "u1", ts: now - i };
    const store = statefulStorage({ own_reactions_v2: seeded });
    const map = () => store.own_reactions_v2 as Record<string, unknown>;

    // 999 + 1 = exactly the cap: nothing may go.
    await setOwnReaction({ site: "facebook", targetId: "atCap", url: "https://www.facebook.com/zuck/posts/2" }, "🔥", "u1");
    expect(Object.keys(map())).toHaveLength(1000);
    expect(map()["facebook:t998"]).toBeDefined(); // the oldest, still here

    // One past it: the single oldest goes, and only that one.
    await setOwnReaction({ site: "facebook", targetId: "overCap", url: "https://www.facebook.com/zuck/posts/3" }, "🔥", "u1");
    expect(Object.keys(map())).toHaveLength(1000);
    expect(map()["facebook:t998"]).toBeUndefined();
    expect(map()["facebook:t997"]).toBeDefined();
    expect(map()["facebook:atCap"]).toBeDefined();
    expect(map()["facebook:overCap"]).toBeDefined();
  });
});

// Same account-scoping contract as the own-reaction store.
describe("auto-native store", () => {
  it("records, overwrites, and null-deletes the pressed action", async () => {
    statefulStorage();
    await setAutoNative(target, "like", "u1");
    expect(await getAutoNative(target, "u1")).toBe("like");
    await setAutoNative(target, "fb:love", "u1");
    expect(await getAutoNative(target, "u1")).toBe("fb:love");
    await setAutoNative(target, null, "u1");
    expect(await getAutoNative(target, "u1")).toBeNull();
  });

  it("never returns or deletes another account's entry", async () => {
    statefulStorage();
    await setAutoNative(target, "dislike", "u1");
    expect(await getAutoNative(target, "u2")).toBeNull();
    await setAutoNative(target, null, "u2");
    expect(await getAutoNative(target, "u1")).toBe("dislike");
  });

  // Account deletion is per-account: wiping u1 must leave u2's record standing.
  it("clearAutoNativesForUser drops only that account's entries", async () => {
    statefulStorage();
    const other: TargetRef = { site: "x", targetId: "t2", url: "https://x.com/i/status/2" };
    await setAutoNative(target, "like", "u1");
    await setAutoNative(other, "dislike", "u2");

    await clearAutoNativesForUser("u1");

    expect(await getAutoNative(target, "u1")).toBeNull();
    expect(await getAutoNative(other, "u2")).toBe("dislike");
  });
});

describe("clearOwnReactionsForUser", () => {
  const mine: TargetRef = { site: "x", targetId: "own-1", url: "https://x.com/i/status/11" };
  const theirs: TargetRef = { site: "x", targetId: "own-2", url: "https://x.com/i/status/12" };

  it("drops only that account's entries", async () => {
    statefulStorage();
    await setOwnReaction(mine, "🔥", "u1");
    await setOwnReaction(theirs, "❤️", "u2");

    await clearOwnReactionsForUser("u1");

    expect(await getOwnReaction(mine, "u1")).toBeNull();
    expect(await getOwnReaction(theirs, "u2")).toBe("❤️");
  });

  it("leaves the store alone when the account owns no entries", async () => {
    const local = statefulStorage();
    await setOwnReaction(theirs, "❤️", "u2");
    const before = JSON.stringify(local.own_reactions_v2);

    await clearOwnReactionsForUser("u1");

    expect(JSON.stringify(local.own_reactions_v2)).toBe(before);
  });
});

describe("getSettings emojiSentiment merge", () => {
  it("defaults: autoTriggerNative off, both default lists present", async () => {
    installFakeChrome();
    const s = await getSettings();
    expect(s.autoTriggerNative).toBe(false);
    expect(s.emojiSentiment.positive).toContain("👍");
    expect(s.emojiSentiment.negative).toContain("👎");
  });

  it("a stored emptied list stays empty instead of re-inheriting defaults", async () => {
    installFakeChrome({ sync: { settings: { emojiSentiment: { positive: [], negative: ["👎"] } } } });
    const s = await getSettings();
    expect(s.emojiSentiment.positive).toEqual([]);
    expect(s.emojiSentiment.negative).toEqual(["👎"]);
  });

  it("settings stored before the feature fall back to the default lists", async () => {
    installFakeChrome({ sync: { settings: { enabled: true } } });
    const s = await getSettings();
    expect(s.emojiSentiment.positive.length).toBeGreaterThan(0);
    expect(s.emojiSentiment.negative.length).toBeGreaterThan(0);
  });
});

describe("setCachedCounts", () => {
  it("does not let an older read overwrite a newer optimistic cache", async () => {
    mockCache({
      counts: { x: 1 },
      total: 1,
      loaded: 1,
      hasMore: false,
      myReaction: "x",
      fetchedAt: 2_000,
    });

    await setCachedCounts(
      {
        [targetKey(target)]: {
          value: { counts: {}, total: 0, loaded: 0, hasMore: false },
          myReaction: null,
        },
      },
      { skipIfCachedAfter: 1_000 },
    );

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it("writes fresh reads when the cached value is not newer", async () => {
    mockCache({
      counts: { x: 1 },
      total: 1,
      loaded: 1,
      hasMore: false,
      myReaction: "x",
      fetchedAt: 500,
    });

    await setCachedCounts(
      {
        [targetKey(target)]: {
          value: { counts: { y: 1 }, total: 1, loaded: 1, hasMore: false },
          myReaction: "y",
        },
      },
      { skipIfCachedAfter: 1_000 },
    );

    expect(chrome.storage.local.set).toHaveBeenCalled();
    const [write] = vi.mocked(chrome.storage.local.set).mock.calls[0]!;
    // LITERAL persisted key, not `cache:${targetKey(...)}`: the storage key is a
    // wire format - a targetKey regression must fail here, not co-mutate the
    // expectation.
    expect(write).toEqual({
      "cache:facebook:1": expect.objectContaining({
        counts: { y: 1 },
        myReaction: "y",
      }),
    });
  });

  // `skipIfCachedAfter` is the timestamp the read was ISSUED at, so an entry stamped at
  // exactly that instant was written by something that started no earlier - the optimistic
  // write racing this read. Equal counts as newer, or the read lands on top of the click the
  // user just made and the count visibly jumps back.
  it("skips a target cached at exactly the read's own timestamp", async () => {
    mockCache({ counts: { x: 1 }, total: 1, loaded: 1, hasMore: false, myReaction: "x", fetchedAt: 1_000 });

    await setCachedCounts({ [targetKey(target)]: { value: { counts: {}, total: 0, loaded: 0, hasMore: false }, myReaction: null } }, { skipIfCachedAfter: 1_000 });

    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });
});

describe("sweepCountsCache", () => {
  function seedCache(entries: Record<string, number>, extra: Record<string, unknown> = {}): Record<string, unknown> {
    const store: Record<string, unknown> = { ...extra };
    for (const [id, fetchedAt] of Object.entries(entries)) {
      store[`cache:facebook:${id}`] = cacheEntry(fetchedAt);
    }
    return statefulStorage(store);
  }

  it("drops entries past the TTL and keeps live ones and non-cache keys", async () => {
    const now = Date.now();
    const store = seedCache({ fresh: now, stale: now - READ_CACHE_TTL_MS - 1 }, { settings: { enabled: true } });

    await sweepCountsCache();

    expect(Object.keys(store)).toContain("cache:facebook:fresh");
    expect(Object.keys(store)).not.toContain("cache:facebook:stale");
    expect(store.settings).toEqual({ enabled: true });
  });

  it("trims the oldest survivors down to the cap", async () => {
    const now = Date.now();
    // All inside the TTL, so only the cap can evict - oldest first.
    const seeds: Record<string, number> = {};
    for (let i = 0; i < 520; i++) seeds[`t${i}`] = now - i;
    const store = seedCache(seeds);

    await sweepCountsCache();

    const left = Object.keys(store).filter((k) => k.startsWith("cache:"));
    expect(left.length).toBe(500);
    expect(left).toContain("cache:facebook:t0"); // newest
    expect(left).not.toContain("cache:facebook:t519"); // oldest
  });

  // The same boundary from both sides: an entry aged exactly the TTL is already a miss for
  // getCachedCounts, so the sweep must not be the one place it counts as live.
  it("drops an entry aged exactly the TTL and keeps the one a tick younger", async () => {
    const now = Date.now();
    const store = seedCache({ atTtl: now - READ_CACHE_TTL_MS, justInside: now - READ_CACHE_TTL_MS + 1 });

    await sweepCountsCache();

    expect(Object.keys(store)).not.toContain("cache:facebook:atTtl");
    expect(Object.keys(store)).toContain("cache:facebook:justInside");
  });

  it("leaves a cache sitting exactly on the cap alone", async () => {
    const now = Date.now();
    const seeds: Record<string, number> = {};
    for (let i = 0; i < 500; i++) seeds[`t${i}`] = now - i;
    const store = seedCache(seeds);

    await sweepCountsCache();

    expect(Object.keys(store).filter((k) => k.startsWith("cache:")).length).toBe(500);
  });

  it("evicts exactly one when the cap is passed by one", async () => {
    const now = Date.now();
    const seeds: Record<string, number> = {};
    for (let i = 0; i < 501; i++) seeds[`t${i}`] = now - i;
    const store = seedCache(seeds);

    await sweepCountsCache();

    const left = Object.keys(store).filter((k) => k.startsWith("cache:"));
    expect(left.length).toBe(500);
    expect(left).not.toContain("cache:facebook:t500"); // the single oldest
  });
});

describe("maybeSweepCountsCache - at most twice an hour", () => {
  it("sweeps on a cold start, then throttles the next call", async () => {
    const now = Date.now();
    const store = statefulStorage({
      "cache:facebook:stale": cacheEntry(now - READ_CACHE_TTL_MS - 1),
    });

    await maybeSweepCountsCache();
    expect(Object.keys(store)).not.toContain("cache:facebook:stale");
    expect(typeof store.cache_swept_at_v1).toBe("number");

    // A stale entry appearing right after must survive the throttled call.
    store["cache:facebook:stale2"] = cacheEntry(now - READ_CACHE_TTL_MS - 1);
    await maybeSweepCountsCache();
    expect(Object.keys(store)).toContain("cache:facebook:stale2");
  });

  it("sweeps again once the interval has elapsed", async () => {
    const now = Date.now();
    const store = statefulStorage({
      cache_swept_at_v1: now - 31 * 60 * 1000,
      "cache:facebook:stale": cacheEntry(now - READ_CACHE_TTL_MS - 1),
    });
    await maybeSweepCountsCache();
    expect(Object.keys(store)).not.toContain("cache:facebook:stale");
  });
});

describe("getCachedCounts / clearCountsCache", () => {
  it("splits fresh hits from expired and missing entries", async () => {
    const now = Date.now();
    const fresh: TargetRef = { site: "facebook", targetId: "fresh", url: "u1" };
    const expired: TargetRef = { site: "facebook", targetId: "expired", url: "u2" };
    const absent: TargetRef = { site: "facebook", targetId: "absent", url: "u3" };
    statefulStorage({
      [`cache:${targetKey(fresh)}`]: { counts: { "❤️": 2 }, total: 2, loaded: 1, hasMore: false, myReaction: null, fetchedAt: now },
      [`cache:${targetKey(expired)}`]: cacheEntry(now - READ_CACHE_TTL_MS - 1),
    });

    const { hits, misses } = await getCachedCounts([fresh, expired, absent]);
    expect(Object.keys(hits)).toEqual([targetKey(fresh)]);
    expect(hits[targetKey(fresh)]?.counts).toEqual({ "❤️": 2 });
    expect(misses).toEqual([expired, absent]);
  });

  // The TTL is a strict bound: an entry aged exactly READ_CACHE_TTL_MS has expired. Pinned
  // from both sides, because either direction of drift is invisible in normal use - one serves
  // a stale count for one more read, the other re-fetches a target a tick early.
  it("expires an entry aged exactly the TTL, keeps the one a tick younger", async () => {
    const now = Date.now();
    const atTtl: TargetRef = { site: "facebook", targetId: "atTtl", url: "u1" };
    const justInside: TargetRef = { site: "facebook", targetId: "justInside", url: "u2" };
    statefulStorage({
      [`cache:${targetKey(atTtl)}`]: cacheEntry(now - READ_CACHE_TTL_MS),
      [`cache:${targetKey(justInside)}`]: cacheEntry(now - READ_CACHE_TTL_MS + 1),
    });

    const { hits, misses } = await getCachedCounts([atTtl, justInside]);

    expect(Object.keys(hits)).toEqual([targetKey(justInside)]);
    expect(misses).toEqual([atTtl]);
  });

  it("normalizes a legacy partial entry (missing total/loaded) instead of dropping it", async () => {
    const now = Date.now();
    statefulStorage({
      [`cache:${targetKey(target)}`]: { counts: { "👍": 3, "❤️": 1 }, fetchedAt: now },
    });
    const { hits } = await getCachedCounts([target]);
    expect(hits[targetKey(target)]).toMatchObject({ total: 4, loaded: 2, hasMore: false, myReaction: null });
  });

  it("clearCountsCache removes only cache-prefixed keys", async () => {
    const store = statefulStorage({
      [`cache:${targetKey(target)}`]: cacheEntry(1),
      own_reactions_v2: { keep: { reaction: "❤️", userId: "u1" } },
    });
    await clearCountsCache();
    expect(Object.keys(store).some((k) => k.startsWith("cache:"))).toBe(false);
    expect(store.own_reactions_v2).toBeDefined();
  });
});

describe("setSettings", () => {
  it("deep-merges the sites map so one toggle can't wipe the rest", async () => {
    const { sync } = installFakeChrome({ sync: { settings: { enabled: true, sites: { facebook: false } } } });
    await setSettings({ sites: { x: false } as never });
    const written = sync.settings as { sites: Record<string, boolean>; enabled: boolean };
    expect(written.sites.facebook).toBe(false);
    expect(written.sites.x).toBe(false);
    expect(written.sites.github).toBe(true); // untouched default survives
    expect(written.enabled).toBe(true);
  });
});
