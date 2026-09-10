// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./messaging", () => ({ sendMessage: vi.fn() }));
vi.mock("../shared/storage", async (importOriginal) => {
  // targetKey stays real (pure); only the async storage reads are mocked.
  const actual = await importOriginal<typeof import("../shared/storage")>();
  return { ...actual, getCachedCounts: vi.fn(), getOwnReaction: vi.fn(), setCachedCounts: vi.fn() };
});
vi.mock("./animations", () => ({ maybePlayPublicReactionIntro: vi.fn() }));

import type { PickerInsertionPoint } from "../shared/adapter";
import type { RuntimeResponse } from "../shared/messages";
import { DEFAULT_BREAKDOWN_LIMIT } from "../shared/reactions";
import { type CachedTarget, getCachedCounts, getOwnReaction, setCachedCounts, targetKey } from "../shared/storage";
import { maybePlayPublicReactionIntro } from "./animations";
import { sendMessage } from "./messaging";
import { clearCachedCountsPrime, hydrateDeferredCounts, loadInitial, pickAggregateCounts, primeCachedCounts, refreshTarget } from "./mount-counts";
import { dropMount, setRefreshCallback } from "./mount-registry";

const point: PickerInsertionPoint = {
  anchor: document.createElement("div"),
  position: "after",
  target: { site: "github", targetId: "torvalds/linux", url: "https://github.com/torvalds/linux" },
};
const key = targetKey(point.target);
const countPayload = { counts: { "👍": 2 }, total: 2, loaded: 2, hasMore: false, myReaction: "👍" };
const countResponse = { type: "count", data: countPayload } as RuntimeResponse;
const aggregate = { counts: { "👍": 2 }, total: 2, loaded: 2, hasMore: false };

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  // The registry is real module state - leave no key behind.
  dropMount(key);
  vi.useRealTimers();
});

describe("pickAggregateCounts", () => {
  it("copies exactly the aggregate fields, nothing else", () => {
    const out = pickAggregateCounts(countPayload);
    expect(out).toEqual(aggregate);
    expect(Object.keys(out).sort()).toEqual(["counts", "hasMore", "loaded", "total"]);
  });
});

describe("refreshTarget", () => {
  it("sign-out strips only the mine marker and fetches nothing", async () => {
    const cb = vi.fn();
    await refreshTarget(cb, point.target, false);
    expect(cb).toHaveBeenCalledWith({ myReaction: null, authed: false });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("sign-in refetches and applies value + myReaction", async () => {
    vi.mocked(sendMessage).mockResolvedValue(countResponse);
    const cb = vi.fn();
    await refreshTarget(cb, point.target, true);
    expect(sendMessage).toHaveBeenCalledWith({ type: "fetchCount", target: point.target, limit: DEFAULT_BREAKDOWN_LIMIT });
    expect(cb).toHaveBeenCalledWith({ value: aggregate, myReaction: "👍", authed: true });
  });

  it("a non-count response applies nothing", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ type: "ok" } as RuntimeResponse);
    const cb = vi.fn();
    await refreshTarget(cb, point.target, true);
    expect(cb).not.toHaveBeenCalled();
  });
});

describe("loadInitial", () => {
  const auth = { authed: true, userId: "u1" };
  const cached: CachedTarget = { ...countPayload, myReaction: "👍", fetchedAt: 0 };

  it("cache hit: cached aggregate, cached myReaction wins over own", async () => {
    vi.mocked(getOwnReaction).mockResolvedValue("❤️");
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: { [key]: cached }, misses: [] });
    expect(await loadInitial(point, auth)).toEqual({ value: aggregate, myReaction: "👍", isLoading: false });
  });

  it("cache hit with null myReaction falls back to the stored own reaction", async () => {
    vi.mocked(getOwnReaction).mockResolvedValue("❤️");
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: { [key]: { ...cached, myReaction: null } }, misses: [] });
    expect((await loadInitial(point, auth)).myReaction).toBe("❤️");
  });

  it("cache miss: empty counts, own reaction, isLoading", async () => {
    vi.mocked(getOwnReaction).mockResolvedValue("❤️");
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: {}, misses: [point.target] });
    expect(await loadInitial(point, auth)).toEqual({
      value: { counts: {}, total: 0, loaded: 0, hasMore: false },
      myReaction: "❤️",
      isLoading: true,
    });
  });

  it("failed local reads degrade to a miss with a null own reaction", async () => {
    vi.mocked(getOwnReaction).mockRejectedValue(new Error("boom"));
    vi.mocked(getCachedCounts).mockRejectedValue(new Error("boom"));
    const res = await loadInitial(point, auth);
    expect(res.myReaction).toBeNull();
    expect(res.isLoading).toBe(true);
  });

  it("signed-out never reads the own-reaction store", async () => {
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: {}, misses: [point.target] });
    await loadInitial(point, { authed: false, userId: null });
    expect(getOwnReaction).not.toHaveBeenCalled();
  });
});

describe("primeCachedCounts", () => {
  const anon = { authed: false, userId: null };
  const cached: CachedTarget = { ...countPayload, myReaction: "👍", fetchedAt: 0 };
  const other: PickerInsertionPoint = {
    ...point,
    target: { site: "github", targetId: "torvalds/uemacs", url: "https://github.com/torvalds/uemacs" },
  };

  beforeEach(() => {
    clearCachedCountsPrime();
  });

  afterEach(() => {
    clearCachedCountsPrime();
  });

  it("serves a primed target without a second cache read", async () => {
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: { [key]: cached }, misses: [] });
    primeCachedCounts([point.target, other.target]);
    await vi.waitFor(() => expect(getCachedCounts).toHaveBeenCalledTimes(1));
    vi.mocked(getCachedCounts).mockClear();

    const initial = await loadInitial(point, anon);

    expect(initial).toEqual({ value: aggregate, myReaction: "👍", isLoading: false });
    expect(getCachedCounts).not.toHaveBeenCalled();
  });

  it("reads through for a target the scan never primed", async () => {
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: {}, misses: [] });
    primeCachedCounts([point.target]);
    await vi.waitFor(() => expect(getCachedCounts).toHaveBeenCalledTimes(1));
    vi.mocked(getCachedCounts).mockClear();

    await loadInitial(other, anon);

    expect(getCachedCounts).toHaveBeenCalledWith([other.target]);
  });

  it("reads through again once the prime has aged out", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 0, 1) });
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: { [key]: cached }, misses: [] });
    primeCachedCounts([point.target]);
    await vi.waitFor(() => expect(getCachedCounts).toHaveBeenCalledTimes(1));
    vi.mocked(getCachedCounts).mockClear();

    // A deferred mount scrolled into view a minute after its scan.
    vi.setSystemTime(Date.UTC(2026, 0, 1) + 60_000);
    await loadInitial(point, anon);

    expect(getCachedCounts).toHaveBeenCalledWith([point.target]);
  });
});

describe("hydrateDeferredCounts", () => {
  // The post-read cache check needs an explicit answer per case; a stub left over from
  // the prime tests above would read as a click that never happened.
  beforeEach(() => {
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: {}, misses: [point.target] });
    vi.mocked(setCachedCounts).mockResolvedValue(undefined);
  });

  it("re-applies a click made while the read was in flight, on top of the server aggregate", async () => {
    // The server answered from before the click (no own reaction, 2 thumbs); the click
    // wrote its own entry over an empty cache, so that entry's aggregate is the delta alone.
    vi.mocked(sendMessage).mockResolvedValue({ type: "count", data: { ...aggregate, myReaction: null } } as RuntimeResponse);
    const clicked: CachedTarget = { counts: { "❤️": 1 }, total: 1, loaded: 1, hasMore: false, myReaction: "❤️", fetchedAt: 5_000 };
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: { [key]: clicked }, misses: [] });
    const cb = vi.fn();
    setRefreshCallback(key, cb);
    await hydrateDeferredCounts(point, key, null, true, false);
    const merged = { counts: { "👍": 2, "❤️": 1 }, total: 3, loaded: 2, hasMore: false };
    expect(cb).toHaveBeenCalledWith({ value: merged, myReaction: "❤️", authed: true });
    expect(setCachedCounts).toHaveBeenCalledWith({ [key]: { value: merged, myReaction: "❤️" } }, { skipIfCachedAfter: 5_001 });
  });

  it("re-applies a toggle-off made while the read was in flight", async () => {
    vi.mocked(sendMessage).mockResolvedValue(countResponse);
    const cleared: CachedTarget = { counts: {}, total: 0, loaded: 0, hasMore: false, myReaction: null, fetchedAt: 5_000 };
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: { [key]: cleared }, misses: [] });
    const cb = vi.fn();
    setRefreshCallback(key, cb);
    await hydrateDeferredCounts(point, key, "👍", true, false);
    expect(cb).toHaveBeenCalledWith({ value: { counts: { "👍": 1 }, total: 1, loaded: 1, hasMore: false }, myReaction: null, authed: true });
  });

  it("leaves a cache that agrees with the server alone", async () => {
    vi.mocked(sendMessage).mockResolvedValue(countResponse);
    vi.mocked(getCachedCounts).mockResolvedValue({ hits: { [key]: { ...countPayload, fetchedAt: 5_000 } }, misses: [] });
    const cb = vi.fn();
    setRefreshCallback(key, cb);
    await hydrateDeferredCounts(point, key, null, true, false);
    expect(cb).toHaveBeenCalledWith({ value: aggregate, myReaction: "👍", authed: true });
    expect(setCachedCounts).not.toHaveBeenCalled();
  });

  it("applies through a registered refresh callback", async () => {
    vi.mocked(sendMessage).mockResolvedValue(countResponse);
    const cb = vi.fn();
    setRefreshCallback(key, cb);
    await hydrateDeferredCounts(point, key, null, true, false);
    expect(sendMessage).toHaveBeenCalledWith({ type: "fetchCount", target: point.target, limit: DEFAULT_BREAKDOWN_LIMIT });
    expect(cb).toHaveBeenCalledWith({ value: aggregate, myReaction: "👍", authed: true });
    expect(maybePlayPublicReactionIntro).not.toHaveBeenCalled();
  });

  it("uses fallbackMine when the server carries no myReaction", async () => {
    vi.mocked(sendMessage).mockResolvedValue({ type: "count", data: aggregate } as RuntimeResponse);
    const cb = vi.fn();
    setRefreshCallback(key, cb);
    await hydrateDeferredCounts(point, key, "🎉", false, false);
    expect(cb).toHaveBeenCalledWith({ value: aggregate, myReaction: "🎉", authed: false });
  });

  it("retries once via setTimeout when the callback registers late", async () => {
    vi.useFakeTimers();
    vi.mocked(sendMessage).mockResolvedValue(countResponse);
    await hydrateDeferredCounts(point, key, null, true, false);
    const cb = vi.fn();
    setRefreshCallback(key, cb);
    vi.advanceTimersByTime(50);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("a failed fetch applies nothing", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("net"));
    const cb = vi.fn();
    setRefreshCallback(key, cb);
    await hydrateDeferredCounts(point, key, null, true, false);
    expect(cb).not.toHaveBeenCalled();
  });

  it("the animations flag gates the public-reaction intro", async () => {
    vi.mocked(sendMessage).mockResolvedValue(countResponse);
    setRefreshCallback(key, vi.fn());
    await hydrateDeferredCounts(point, key, null, true, true);
    expect(maybePlayPublicReactionIntro).toHaveBeenCalledWith(aggregate);
  });
});
