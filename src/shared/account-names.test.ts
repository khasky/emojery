// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountLabel } from "./account-label";
import { ACCOUNT_NAMES_KEY, ACCOUNTS_SEEN_KEY, accountDisplayName, forgetAccount, lastAccountPerProvider, noteAccountSeen, readSeenAccounts, setAccountName } from "./account-names";

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
    await expect(accountDisplayName("u_1")).resolves.toHaveLength(32);
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

    await expect(lastAccountPerProvider()).resolves.toEqual({ google: "work", slack: accountLabel("u_slack") });
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

    await expect(readSeenAccounts()).resolves.toEqual([{ provider: "apple", userId: "u_2", at: 2_000 }]);
    await expect(accountDisplayName("u_1")).resolves.toBe(accountLabel("u_1"));
    await expect(accountDisplayName("u_2")).resolves.toBe("personal");
  });
});
