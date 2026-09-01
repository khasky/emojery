// SPDX-License-Identifier: GPL-3.0-or-later
//
// History store semantics against REAL IndexedDB (Vitest browser mode: WebKit and
// Firefox; WebKit is the weakest supported engine for IDB, so this doubles as a
// Safari-shaped smoke test). Covers dedupe/move/remove, paging, search, the legacy storage.local
// migration, and a volume run that keeps paging and search honest at scale.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TargetRef } from "../shared/adapter";
import type { ReactionHistoryItem } from "../shared/messages";
import { getRecentEmojis, importRecentEmojiStats } from "../shared/recents";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { clearHistory, clearHistoryForUser, exportHistory, getHistoryPage, getHistoryStats, importHistory, importHistoryRows, migrateLegacyHistory, pushHistory, removeHistoryEntry, SEARCH_BATCH } from "./history";

const USER = "user-a";
const OTHER = "user-b";

const target: TargetRef = {
  site: "facebook",
  targetId: "1",
  url: "https://www.facebook.com/zuck/posts/1",
};

// Count the batched index reads a block performs. `getAll` and `getAllKeys` are
// the only reads the history store issues, so the count is the structural answer
// to "did this walk the account row by row" - a wall-clock budget cannot tell a
// rescan from a loaded machine, and reddens on the machine.
async function withIndexReadCounter<T>(run: (reads: () => number) => Promise<T>): Promise<T> {
  const index = IDBIndex.prototype;
  const realGetAll = index.getAll;
  const realGetAllKeys = index.getAllKeys;
  let reads = 0;
  index.getAll = function counted(this: IDBIndex, ...args: Parameters<IDBIndex["getAll"]>) {
    reads++;
    return realGetAll.apply(this, args);
  };
  index.getAllKeys = function counted(this: IDBIndex, ...args: Parameters<IDBIndex["getAllKeys"]>) {
    reads++;
    return realGetAllKeys.apply(this, args);
  };
  try {
    return await run(() => reads);
  } finally {
    index.getAll = realGetAll;
    index.getAllKeys = realGetAllKeys;
  }
}

function row(i: number, userId = USER, overrides: Partial<ReactionHistoryItem> = {}): ReactionHistoryItem {
  return {
    userId,
    target: { site: "github", targetId: `seed-${i}`, url: `https://github.com/e2e-seed/repo-${i}` },
    reaction: ["❤️", "🔥", "👍"][i % 3]!,
    ts: 1_000 + i,
    ...overrides,
  };
}

async function readAll(userId: string, query?: string, limit = 100): Promise<ReactionHistoryItem[]> {
  const all: ReactionHistoryItem[] = [];
  let cursor: number | null = null;
  for (;;) {
    const page = await getHistoryPage(userId, { limit, cursor, ...(query ? { query } : {}) });
    all.push(...page.items);
    if (page.cursor === null) return all;
    if (page.items.length === 0) return all; // exhausted exactly at a page boundary
    cursor = page.cursor;
  }
}

let chromeShim: ChromeShimHandle;

beforeEach(async () => {
  chromeShim = installChromeShim();
  await clearHistory();
});
afterEach(() => chromeShim.uninstall());

describe("history - write semantics", () => {
  it("dedupes confirmed optimistic entries by historyId", async () => {
    await pushHistory(USER, target, "❤️", { historyId: "hist-1", ts: 100 });
    await pushHistory(USER, target, "❤️", { historyId: "hist-1", ts: 100 });

    await expect(readAll(USER)).resolves.toHaveLength(1);
  });

  it("moves an optimistic entry when confirmation belongs to a new user", async () => {
    await pushHistory("old-user", target, "❤️", { historyId: "hist-1", ts: 100 });
    await pushHistory("new-user", target, "❤️", { historyId: "hist-1", ts: 100 });

    await expect(readAll("old-user")).resolves.toEqual([]);
    await expect(readAll("new-user")).resolves.toMatchObject([{ historyId: "hist-1", userId: "new-user", reaction: "❤️", ts: 100 }]);
  });

  it("stores the click action so the popup can tint the row", async () => {
    await pushHistory(USER, target, "❤️", { historyId: "hist-1", ts: 100, action: "add" });
    await pushHistory(USER, target, "👍", { historyId: "hist-2", ts: 200, action: "remove" });

    await expect(readAll(USER)).resolves.toMatchObject([
      { reaction: "👍", action: "remove" },
      { reaction: "❤️", action: "add" },
    ]);
  });

  it("omits action entirely for legacy pushes without one", async () => {
    await pushHistory(USER, target, "❤️", { historyId: "hist-1", ts: 100 });

    const [item] = await readAll(USER);
    expect(item).not.toHaveProperty("action");
  });

  it("removes only the matching optimistic entry", async () => {
    await pushHistory(USER, target, "❤️", { historyId: "hist-1", ts: 100 });
    await pushHistory(USER, target, "👍", { historyId: "hist-2", ts: 200 });

    await removeHistoryEntry("hist-1");

    await expect(readAll(USER)).resolves.toMatchObject([{ historyId: "hist-2", reaction: "👍", ts: 200 }]);
  });

  it("maintains the picker's recents stats alongside writes", async () => {
    await pushHistory(USER, target, "❤️", { historyId: "hist-1", ts: 100 });
    await pushHistory(USER, target, "❤️", { historyId: "hist-2", ts: 200 });
    expect(chromeShim.local.get("recents_v1")).toEqual({ [USER]: { "❤️": { count: 2, lastUsed: 200 } } });

    // The drop keeps the newest stamp (a one-off drift the next write overwrites).
    await removeHistoryEntry("hist-2");
    expect(chromeShim.local.get("recents_v1")).toEqual({ [USER]: { "❤️": { count: 1, lastUsed: 200 } } });
  });
});

describe("history - paging and search", () => {
  it("pages newest-first without overlap and isolates accounts", async () => {
    await importHistoryRows(Array.from({ length: 250 }, (_, i) => row(i)));
    await importHistoryRows(Array.from({ length: 5 }, (_, i) => row(i, OTHER)));

    const first = await getHistoryPage(USER, { limit: 100, cursor: null });
    expect(first.items).toHaveLength(100);
    expect(first.items[0]!.target.url).toContain("repo-249");
    expect(first.cursor).not.toBeNull();

    const second = await getHistoryPage(USER, { limit: 100, cursor: first.cursor });
    expect(second.items[0]!.target.url).toContain("repo-149");

    const all = await readAll(USER);
    expect(all).toHaveLength(250);
    expect(new Set(all.map((it) => it.target.targetId)).size).toBe(250);
    expect(all.every((it) => it.userId === USER)).toBe(true);
  });

  it("filters by url, site, and emoji, case-insensitively", async () => {
    await importHistoryRows([row(1, USER, { reaction: "🔥" }), { ...row(2), target: { site: "facebook", targetId: "f", url: "https://www.facebook.com/zuck/posts/9" } }, row(3, USER, { reaction: "❤️" })]);

    await expect(readAll(USER, "FACEBOOK")).resolves.toHaveLength(1);
    await expect(readAll(USER, "repo-")).resolves.toHaveLength(2);
    await expect(readAll(USER, "🔥")).resolves.toMatchObject([{ reaction: "🔥" }]);
    await expect(readAll(USER, "no-such-thing")).resolves.toEqual([]);
  });

  it("narrows a page by the site, emoji, and since facets (AND, newest-first)", async () => {
    const base = 10_000;
    await importHistoryRows([
      { userId: USER, target: { site: "github", targetId: "g1", url: "https://github.com/g1" }, reaction: "❤️", ts: base + 1 },
      { userId: USER, target: { site: "facebook", targetId: "f1", url: "https://www.facebook.com/f1" }, reaction: "❤️", ts: base + 2 },
      { userId: USER, target: { site: "github", targetId: "g2", url: "https://github.com/g2" }, reaction: "🔥", ts: base + 3 },
    ]);

    const ids = async (opts: Parameters<typeof getHistoryPage>[1]) => (await getHistoryPage(USER, opts)).items.map((it) => it.target.targetId);

    await expect(ids({ limit: 100, site: "github" })).resolves.toEqual(["g2", "g1"]);
    await expect(ids({ limit: 100, emoji: "❤️" })).resolves.toEqual(["f1", "g1"]);
    await expect(ids({ limit: 100, since: base + 2 })).resolves.toEqual(["g2", "f1"]);
    await expect(ids({ limit: 100, site: "github", emoji: "🔥" })).resolves.toEqual(["g2"]);
  });
});

describe("history - stats", () => {
  it("aggregates device-local totals and per-key distributions", async () => {
    const now = Date.now();
    const DAY = 86_400_000;
    await importHistoryRows([
      { userId: USER, target: { site: "github", targetId: "a", url: "https://github.com/a" }, reaction: "❤️", ts: now, action: "add" },
      { userId: USER, target: { site: "github", targetId: "b", url: "https://github.com/b" }, reaction: "❤️", ts: now - DAY, action: "change" },
      { userId: USER, target: { site: "facebook", targetId: "c", url: "https://www.facebook.com/c" }, reaction: "🔥", ts: now - 3 * DAY, action: "remove" },
      // Another account's row must not leak into USER's stats.
      { userId: OTHER, target: { site: "reddit", targetId: "d", url: "https://www.reddit.com/d" }, reaction: "👍", ts: now, action: "add" },
    ]);

    const stats = await getHistoryStats(USER);
    expect(stats.total).toBe(3); // the remove is still a history row
    expect(stats.byEmoji).toEqual({ "❤️": 2, "🔥": 1 });
    expect(stats.bySite).toEqual({ github: 2, facebook: 1 });
  });

  it("returns zeros for an account with no history", async () => {
    await expect(getHistoryStats("nobody")).resolves.toMatchObject({ total: 0, byEmoji: {}, bySite: {} });
  });

  it("keeps the aggregates exact across add, remove and a confirmed duplicate", async () => {
    await pushHistory(USER, target, "❤️", { historyId: "s1", ts: 1 });
    await pushHistory(USER, { site: "github", targetId: "o/r", url: "https://github.com/o/r" }, "🔥", { historyId: "s2", ts: 2 });
    // Another account's write must not move USER's numbers.
    await pushHistory(OTHER, target, "👍", { historyId: "s3", ts: 3 });
    expect(await getHistoryStats(USER)).toEqual({ total: 2, byEmoji: { "❤️": 1, "🔥": 1 }, bySite: { facebook: 1, github: 1 } });

    // A confirmation of a row already stored writes nothing.
    await pushHistory(USER, target, "❤️", { historyId: "s1", ts: 1 });
    expect(await getHistoryStats(USER)).toEqual({ total: 2, byEmoji: { "❤️": 1, "🔥": 1 }, bySite: { facebook: 1, github: 1 } });

    // Removing the last row of a key drops the key rather than leaving it at zero -
    // a from-scratch scan would never emit an empty bucket, and the facet list renders
    // every key it is handed.
    await removeHistoryEntry("s2");
    expect(await getHistoryStats(USER)).toEqual({ total: 1, byEmoji: { "❤️": 1 }, bySite: { facebook: 1 } });

    await removeHistoryEntry("s1");
    expect(await getHistoryStats(USER)).toEqual({ total: 0, byEmoji: {}, bySite: {} });
  });

  it("takes a write's delta instead of rescanning the account's rows", async () => {
    // The store is uncapped, so re-deriving the stats costs a pass over every row the
    // account ever wrote. A single-row write must hand the caches its delta: after one
    // warm read, neither a push nor a remove may send the next read back to the store.
    await pushHistory(USER, target, "❤️", { historyId: "w1", ts: 1 });
    await getHistoryStats(USER);

    await withIndexReadCounter(async (reads) => {
      await pushHistory(USER, { site: "github", targetId: "o/r", url: "https://github.com/o/r" }, "🔥", { historyId: "w2", ts: 2 });
      expect(await getHistoryStats(USER)).toEqual({ total: 2, byEmoji: { "❤️": 1, "🔥": 1 }, bySite: { facebook: 1, github: 1 } });
      expect(reads(), "a push must not force a re-scan").toBe(0);

      await removeHistoryEntry("w2");
      expect(await getHistoryStats(USER)).toEqual({ total: 1, byEmoji: { "❤️": 1 }, bySite: { facebook: 1 } });
      expect(reads(), "a remove must not force a re-scan").toBe(0);
    });
  });
});

describe("history - export/import", () => {
  it("exports portable rows shaped like the vote payload, without ids or userId", async () => {
    await pushHistory(USER, target, "❤️", { historyId: "h1", ts: 500, action: "add" });

    const rows = await exportHistory(USER);
    expect(rows).toEqual([{ site: "facebook", targetId: "1", targetUrl: "https://www.facebook.com/zuck/posts/1", reaction: "❤️", ts: 500, action: "add" }]);
    expect(rows[0]).not.toHaveProperty("userId");
    expect(rows[0]).not.toHaveProperty("id");
    expect(rows[0]).not.toHaveProperty("historyId");
  });

  it("import replaces the account's history, re-homed and ts-ordered", async () => {
    await importHistoryRows([row(1, USER), row(2, USER)]);

    const portable = [
      { site: "github" as const, targetId: "g1", targetUrl: "https://github.com/g1", reaction: "🔥", ts: 300, action: "add" as const },
      { site: "github" as const, targetId: "g2", targetUrl: "https://github.com/g2", reaction: "❤️", ts: 100 },
      // A duplicate within the file is dropped.
      { site: "github" as const, targetId: "g1", targetUrl: "https://github.com/g1", reaction: "🔥", ts: 300, action: "add" as const },
    ];

    await expect(importHistory(USER, portable)).resolves.toEqual({ imported: 2, replaced: 2 });

    const all = await readAll(USER);
    // Seed rows are gone; inserted oldest-ts first, so newest-first puts ts:300 on top.
    expect(all.map((r) => [r.target.targetId, r.ts])).toEqual([
      ["g1", 300],
      ["g2", 100],
    ]);
    expect(all.every((r) => r.userId === USER)).toBe(true);
    expect(all[0]!.target.url).toBe("https://github.com/g1");
  });

  it("round-trips an export into a different account", async () => {
    await pushHistory(USER, target, "👍", { historyId: "h1", ts: 700, action: "add" });

    const exported = await exportHistory(USER);
    await expect(importHistory(OTHER, exported)).resolves.toEqual({ imported: 1, replaced: 0 });
    await expect(readAll(OTHER)).resolves.toMatchObject([{ userId: OTHER, reaction: "👍", ts: 700, action: "add" }]);
    // The original account is untouched by the cross-account import.
    await expect(readAll(USER)).resolves.toHaveLength(1);
  });
});

describe("history - account deletion", () => {
  // Deleting one account must leave a second account's rows on the device: both
  // can be signed in over the same browser profile, and the wholesale store
  // wipe this replaced destroyed the other account's history with them.
  it("clearHistoryForUser drops only the named account's rows", async () => {
    await importHistoryRows([row(1, USER), row(2, USER), row(3, OTHER)]);

    await clearHistoryForUser(USER);

    await expect(readAll(USER)).resolves.toEqual([]);
    await expect(readAll(OTHER)).resolves.toHaveLength(1);
  });

  it("clearHistoryForUser drops that account's derived recents, keeping the others", async () => {
    await importRecentEmojiStats({ [USER]: { "🔥": { count: 3, lastUsed: 9 } }, [OTHER]: { "❤️": { count: 1, lastUsed: 5 } } });

    await clearHistoryForUser(USER);

    await expect(getRecentEmojis(USER, 18)).resolves.toEqual([]);
    await expect(getRecentEmojis(OTHER, 18)).resolves.toEqual(["❤️"]);
  });
});

describe("history - volume", () => {
  // WebKit pays a per-add() cost on IndexedDB even inside one transaction, steep enough
  // that seeding ten thousand rows here would cost minutes. This test owns engine
  // correctness at scale; the full-volume run lives in the Chromium e2e
  // (e2e/history-pagination.spec.ts), where the real popup pages over it.
  const VOLUME = 2_000;

  it("pages and searches thousands of rows correctly and responsively", async () => {
    await importHistoryRows(Array.from({ length: VOLUME }, (_, i) => row(i)));
    // A sprinkle of another account's rows to prove index isolation at scale.
    await importHistoryRows(Array.from({ length: 50 }, (_, i) => row(i, OTHER)));

    const first = await withIndexReadCounter(async (reads) => {
      const page = await getHistoryPage(USER, { limit: 100, cursor: null });
      // A page is two index reads whatever the store holds: the account's id
      // list, then one batch of exactly the rows it returns.
      expect(reads(), "an unfiltered page must not scale with store size").toBe(2);
      return page;
    });
    expect(first.items).toHaveLength(100);
    expect(first.items[0]!.target.url).toContain(`repo-${VOLUME - 1}`);
    expect(first.cursor).not.toBeNull();

    // Rare-match search walks the account once, in SEARCH_BATCH-sized reads,
    // reusing the cached id list - never a read per row.
    const needle = await withIndexReadCounter(async (reads) => {
      const found = await readAll(USER, "repo-1042");
      expect(reads(), "search must batch, not read per row").toBe(Math.ceil(VOLUME / SEARCH_BATCH));
      return found;
    });
    expect(needle.map((it) => it.target.targetId)).toEqual(["seed-1042"]);

    // Broad-match search pages like the unfiltered list.
    const broad = await getHistoryPage(USER, { limit: 100, query: "repo-", cursor: null });
    expect(broad.items).toHaveLength(100);
    expect(broad.cursor).not.toBeNull();

    // Full walk covers every row exactly once, over more rows than one page holds.
    const all = await readAll(USER, undefined, 500);
    expect(all).toHaveLength(VOLUME);
    expect(new Set(all.map((it) => it.target.targetId)).size).toBe(VOLUME);
  }, 180_000);
});

describe("history - legacy storage.local migration", () => {
  it("imports the newest-first array preserving display order, derives recents, and removes the keys", async () => {
    // The legacy array was newest-first; repo-0 is the newest row.
    const legacy = Array.from({ length: 30 }, (_, i) => ({ ...row(i), ts: 5_000 - i }));
    chromeShim.local.set("history", legacy);
    chromeShim.local.set("frequent_cleared_v1", { [USER]: 4_990 }); // hides ts <= 4990 from recents

    await migrateLegacyHistory();

    const all = await readAll(USER);
    expect(all).toHaveLength(30);
    expect(all[0]!.target.url).toContain("repo-0");
    expect(all[29]!.target.url).toContain("repo-29");

    // Recents derived only from rows newer than the old clear marker
    // (ts 5000..4991 = repo-0..repo-9: 4x❤️ at i%3==0, 3x🔥, 3x👍).
    expect(chromeShim.local.get("recents_v1")).toEqual({
      [USER]: {
        "❤️": { count: 4, lastUsed: 5_000 },
        "🔥": { count: 3, lastUsed: 4_999 },
        "👍": { count: 3, lastUsed: 4_998 },
      },
    });

    expect(chromeShim.local.get("history")).toBeUndefined();
    expect(chromeShim.local.get("frequent_cleared_v1")).toBeUndefined();

    // Re-running is a no-op - no duplicate rows.
    await migrateLegacyHistory();
    await expect(readAll(USER)).resolves.toHaveLength(30);
  });

  it("is a no-op without a legacy array", async () => {
    await migrateLegacyHistory();
    await expect(readAll(USER)).resolves.toEqual([]);
  });
});
