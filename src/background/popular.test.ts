// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageLocalGet = vi.fn();
const storageLocalSet = vi.fn();
vi.mock("../shared/webext", () => ({
  storageLocalGet: (keys: string[]) => storageLocalGet(keys),
  storageLocalSet: (items: Record<string, unknown>) => storageLocalSet(items),
}));

vi.mock("../shared/config", () => ({ API_BASE: "https://api.test", API_TIMEOUT_MS: 10_000 }));

import { POPULAR_TTL_MS, type StoredPopular } from "../shared/popular";
import { ensurePopularFresh } from "./popular";

// Frozen clock: the freshness check is `Date.now() - fetchedAt < POPULAR_TTL_MS`,
// so the boundary is probed exactly (TTL - 1 fresh, TTL stale) instead of with
// wall-clock-relative offsets.
const FROZEN_NOW = Date.UTC(2026, 0, 1);

function response(body: unknown, status = 200): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), { status });
}

function storedArg(): StoredPopular {
  const call = storageLocalSet.mock.calls[0]?.[0] as { popular_v1: StoredPopular } | undefined;
  return call!.popular_v1;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  storageLocalGet.mockReset();
  storageLocalSet.mockReset();
  storageLocalGet.mockResolvedValue({});
  storageLocalSet.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ensurePopularFresh", () => {
  it("fetches and caches when nothing is cached", async () => {
    fetchMock.mockResolvedValue(response({ emojis: ["🔥", "👍"] }));
    await ensurePopularFresh();
    // The client identity headers are a required part of the request.
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/reactions/popular",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({ "x-emojery-client": "extension" }),
      }),
    );
    expect(storageLocalSet).toHaveBeenCalledTimes(1);
    expect(storedArg().emojis).toEqual(["🔥", "👍"]);
    expect(typeof storedArg().fetchedAt).toBe("number");
  });

  it("no-ops when the cache is one tick inside the TTL", async () => {
    storageLocalGet.mockResolvedValue({
      popular_v1: { emojis: ["🔥"], fetchedAt: FROZEN_NOW - POPULAR_TTL_MS + 1 },
    });
    await ensurePopularFresh();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storageLocalSet).not.toHaveBeenCalled();
  });

  it("refetches the moment the TTL lapses", async () => {
    storageLocalGet.mockResolvedValue({
      popular_v1: { emojis: ["🔥"], fetchedAt: FROZEN_NOW - POPULAR_TTL_MS },
    });
    fetchMock.mockResolvedValue(response({ emojis: ["🎉"] }));
    await ensurePopularFresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(storedArg().emojis).toEqual(["🎉"]);
  });

  it("keeps the old cache on a non-ok response", async () => {
    fetchMock.mockResolvedValue(response(undefined, 500));
    await ensurePopularFresh();
    expect(storageLocalSet).not.toHaveBeenCalled();
  });

  it("keeps the old cache on a malformed body", async () => {
    fetchMock.mockResolvedValue(response({ emojis: [] }));
    await ensurePopularFresh();
    expect(storageLocalSet).not.toHaveBeenCalled();
  });

  it("keeps the old cache on a network error", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));
    await ensurePopularFresh();
    expect(storageLocalSet).not.toHaveBeenCalled();
  });

  it("coalesces concurrent calls into one fetch", async () => {
    let resolveFetch: (r: Response) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise<Response>((r) => {
        resolveFetch = r;
      }),
    );
    const a = ensurePopularFresh();
    const b = ensurePopularFresh();
    resolveFetch(response({ emojis: ["🔥"] }));
    await Promise.all([a, b]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
