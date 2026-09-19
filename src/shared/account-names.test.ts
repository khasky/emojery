// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountLabel } from "./account-label";
import { ACCOUNT_NAME_MAX, ACCOUNT_NAMES_KEY, ACCOUNTS_SEEN_KEY, accountDisplayName, accountOrdinal, forgetAccount, lastAccountPerProvider, noteAccountSeen, providerTag, readSeenAccounts, setAccountName } from "./account-names";

let store: Record<string, unknown> = {};

beforeEach(() => {
  store = {};
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: (keys: string[], done: (items: Record<string, unknown>) => void) => done(Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))),
        set: (items: Record<string, unknown>, done: () => void) => {
          Object.assign(store, items);
          done();
        },
        remove: (keys: string[], done: () => void) => {
          for (const k of keys) delete store[k];
          done();
        },
      },
    },
  });
});

describe("account names", () => {
  it("falls back to the derived label until the reader names the account", async () => {
    await expect(accountDisplayName("u_1")).resolves.toBe(accountLabel("u_1"));
    await setAccountName("u_1", "work");
    await expect(accountDisplayName("u_1")).resolves.toBe("work");
  });

  it("restores the label when the name is cleared, and keeps the store empty", async () => {
    await setAccountName("u_1", "work");
    await setAccountName("u_1", "   ");
    await expect(accountDisplayName("u_1")).resolves.toBe(accountLabel("u_1"));
    expect(store[ACCOUNT_NAMES_KEY]).toBeUndefined();
  });

  it("caps a name at the length the row can show", async () => {
    await setAccountName("u_1", "x".repeat(80));
    await expect(accountDisplayName("u_1")).resolves.toHaveLength(ACCOUNT_NAME_MAX);
  });

  it("ignores a store someone else wrote in another shape", async () => {
    store[ACCOUNT_NAMES_KEY] = { u_1: 42 };
    store[ACCOUNTS_SEEN_KEY] = "not an array";
    await expect(accountDisplayName("u_1")).resolves.toBe(accountLabel("u_1"));
    await expect(readSeenAccounts()).resolves.toEqual([]);
  });
});

describe("accounts seen on this device", () => {
  it("names the newest account per provider, the reader's name winning", async () => {
    await noteAccountSeen("google", "u_old", 1_000);
    await noteAccountSeen("google", "u_new", 2_000);
    await noteAccountSeen("slack", "u_slack", 1_500);
    await setAccountName("u_new", "work");

    await expect(lastAccountPerProvider()).resolves.toEqual({
      google: { name: "work", ordinal: 2, at: 2_000 },
      slack: { name: accountLabel("u_slack"), ordinal: 1, at: 1_500 },
    });
  });

  it("re-signing in with the same account moves it up rather than duplicating it", async () => {
    await noteAccountSeen("google", "u_1", 1_000);
    await noteAccountSeen("apple", "u_2", 2_000);
    await noteAccountSeen("google", "u_1", 3_000);

    const seen = await readSeenAccounts();
    expect(seen.map((e) => e.userId)).toEqual(["u_1", "u_2"]);
  });

  it("forgets one account's name and history, leaving the others", async () => {
    await noteAccountSeen("google", "u_1", 1_000);
    await noteAccountSeen("apple", "u_2", 2_000);
    await setAccountName("u_1", "work");
    await setAccountName("u_2", "personal");

    await forgetAccount("u_1");

    await expect(readSeenAccounts()).resolves.toEqual([{ provider: "apple", userId: "u_2", at: 2_000, ordinal: 1 }]);
    await expect(accountDisplayName("u_1")).resolves.toBe(accountLabel("u_1"));
    await expect(accountDisplayName("u_2")).resolves.toBe("personal");
  });
});

describe("which account of its provider", () => {
  it("numbers the accounts of one provider in the order they were first used", async () => {
    await noteAccountSeen("google", "u_1", 1_000);
    await noteAccountSeen("google", "u_2", 2_000);
    await noteAccountSeen("apple", "u_3", 3_000);

    await expect(accountOrdinal("u_1")).resolves.toBe(1);
    await expect(accountOrdinal("u_2")).resolves.toBe(2);
    // Each provider counts from one.
    await expect(accountOrdinal("u_3")).resolves.toBe(1);
  });

  it("keeps an account's number when it signs in again", async () => {
    await noteAccountSeen("google", "u_1", 1_000);
    await noteAccountSeen("google", "u_2", 2_000);
    await noteAccountSeen("google", "u_1", 3_000);

    await expect(accountOrdinal("u_1")).resolves.toBe(1);
    await expect(accountOrdinal("u_2")).resolves.toBe(2);
  });

  // The number identifies the account whatever it is called, so renaming the first
  // must not hand its number to the second.
  it("does not hand a renamed account's number to the next one", async () => {
    await noteAccountSeen("google", "u_1", 1_000);
    await setAccountName("u_1", "work");
    await noteAccountSeen("google", "u_2", 2_000);

    await expect(accountDisplayName("u_1")).resolves.toBe("work");
    await expect(accountOrdinal("u_2")).resolves.toBe(2);
  });

  // A record pruned by the seen-cap, or written before ordinals existed: the tag then
  // names the provider alone rather than claiming a number the account never had.
  it("has no number for an account it holds no record of", async () => {
    await expect(accountOrdinal("u_unknown")).resolves.toBe(0);
    expect(providerTag("google", 0)).toBe("Google");
    expect(providerTag("google", 2)).toBe("Google #2");
  });
});
