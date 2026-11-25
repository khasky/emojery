// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const storageLocalGet = vi.fn();
const storageLocalSet = vi.fn();
vi.mock("./webext", () => ({
  storageLocalGet: (keys: string[]) => storageLocalGet(keys),
  storageLocalSet: (items: Record<string, unknown>) => storageLocalSet(items),
}));

import { bumpRecentEmoji, clearRecentEmojis, dropRecentEmoji, getRecentEmojis } from "./recents";

const USER = "user-1";

// `n` distinct emojis with ascending lastUsed (the last one is the newest).
function stats(n: number): Record<string, { count: number; lastUsed: number }> {
  const base = ["🔥", "❤️", "😂", "👍", "🎉", "😍", "🥰", "😎", "💯", "✅", "🙏", "👏", "🤔", "😭", "😡", "🤯", "🥳", "😴", "👀", "💀", "🤝", "🙌", "😅", "😇", "🤩"] as const;
  return Object.fromEntries(Array.from({ length: n }, (_, i) => [base[i % base.length]!, { count: 1, lastUsed: 1_000 + i }]));
}

beforeEach(() => {
  storageLocalGet.mockReset();
  storageLocalSet.mockReset();
  storageLocalSet.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getRecentEmojis", () => {
  it("caps the list at the requested limit", async () => {
    storageLocalGet.mockResolvedValue({ recents_v1: { [USER]: stats(25) } });
    expect(await getRecentEmojis(USER, 18)).toHaveLength(18);
  });

  it("orders most-recently-used first, count as tiebreaker", async () => {
    storageLocalGet.mockResolvedValue({
      recents_v1: {
        [USER]: {
          "🔥": { count: 9, lastUsed: 1_000 },
          "❤️": { count: 1, lastUsed: 2_000 }, // newest wins despite count 1
          "😂": { count: 5, lastUsed: 1_000 }, // same lastUsed as 🔥, so count decides
        },
      },
    });
    expect(await getRecentEmojis(USER, 18)).toEqual(["❤️", "🔥", "😂"]);
  });

  it("returns only the named user's stats", async () => {
    storageLocalGet.mockResolvedValue({
      recents_v1: { [USER]: { "🔥": { count: 1, lastUsed: 1 } }, "someone-else": { "💩": { count: 9, lastUsed: 9 } } },
    });
    expect(await getRecentEmojis(USER, 18)).toEqual(["🔥"]);
  });

  it("returns nothing for a user with no stored stats", async () => {
    storageLocalGet.mockResolvedValue({ recents_v1: { "someone-else": stats(3) } });
    expect(await getRecentEmojis(USER, 18)).toEqual([]);
  });

  // The read must not pull the auth record: it carries the bearer token, and the
  // picker runs this in a content script on a page the extension does not trust.
  it("never reads the auth record", async () => {
    storageLocalGet.mockResolvedValue({ recents_v1: { [USER]: stats(3) } });
    await getRecentEmojis(USER, 18);
    for (const [keys] of storageLocalGet.mock.calls) {
      expect(keys).not.toContain("auth_v1");
    }
  });
});

describe("clearRecentEmojis", () => {
  it("drops only the named user's stats, preserving other accounts", async () => {
    storageLocalGet.mockResolvedValue({
      recents_v1: { [USER]: stats(3), "another-user": { "🎉": { count: 2, lastUsed: 7 } } },
    });

    await clearRecentEmojis(USER);

    expect(storageLocalSet).toHaveBeenCalledWith({
      recents_v1: { "another-user": { "🎉": { count: 2, lastUsed: 7 } } },
    });
  });

  it("never reads the auth record", async () => {
    storageLocalGet.mockResolvedValue({ recents_v1: { [USER]: stats(1) } });
    await clearRecentEmojis(USER);
    for (const [keys] of storageLocalGet.mock.calls) {
      expect(keys).not.toContain("auth_v1");
    }
  });
});

describe("background-side stat maintenance", () => {
  it("bump creates an entry and then increments it, keeping the newest stamp", async () => {
    storageLocalGet.mockResolvedValue({});
    await bumpRecentEmoji(USER, "🔥", 1_000);
    expect(storageLocalSet).toHaveBeenCalledWith({ recents_v1: { [USER]: { "🔥": { count: 1, lastUsed: 1_000 } } } });

    storageLocalGet.mockResolvedValue({ recents_v1: { [USER]: { "🔥": { count: 1, lastUsed: 1_000 } } } });
    await bumpRecentEmoji(USER, "🔥", 500); // an older ts must not move lastUsed back
    expect(storageLocalSet).toHaveBeenLastCalledWith({ recents_v1: { [USER]: { "🔥": { count: 2, lastUsed: 1_000 } } } });
  });

  it("drop decrements and removes the entry at zero", async () => {
    storageLocalGet.mockResolvedValue({ recents_v1: { [USER]: { "🔥": { count: 2, lastUsed: 1_000 } } } });
    await dropRecentEmoji(USER, "🔥");
    expect(storageLocalSet).toHaveBeenLastCalledWith({ recents_v1: { [USER]: { "🔥": { count: 1, lastUsed: 1_000 } } } });

    storageLocalGet.mockResolvedValue({ recents_v1: { [USER]: { "🔥": { count: 1, lastUsed: 1_000 } } } });
    await dropRecentEmoji(USER, "🔥");
    expect(storageLocalSet).toHaveBeenLastCalledWith({ recents_v1: { [USER]: {} } });
  });

  it("drop is a no-op for an unknown emoji or user", async () => {
    storageLocalGet.mockResolvedValue({ recents_v1: { [USER]: { "🔥": { count: 1, lastUsed: 1 } } } });
    await dropRecentEmoji(USER, "❤️");
    await dropRecentEmoji("nobody", "🔥");
    expect(storageLocalSet).not.toHaveBeenCalled();
  });
});
