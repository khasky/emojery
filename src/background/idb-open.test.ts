// SPDX-License-Identifier: GPL-3.0-or-later
//
// The connection lifecycle both stores share. Driven against a fake IDBFactory rather
// than a real one because what is under test is the EVENT handling - versionchange,
// blocked, close, a failed open - and a real IndexedDB will not produce a blocked event
// on demand. The stores' real behaviour against a real database is covered by
// history.browser.test.ts / votequeue.browser.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdbHandle, runTransaction } from "./idb-open";

interface FakeRequest {
  result: FakeDb;
  error: DOMException | null;
  onupgradeneeded: (() => void) | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
  onblocked: (() => void) | null;
}

interface FakeDb {
  closed: boolean;
  close: () => void;
  onversionchange: (() => void) | null;
  onclose: (() => void) | null;
  objectStoreNames: { contains: (name: string) => boolean };
}

let opens: FakeRequest[] = [];

function makeDb(): FakeDb {
  const db: FakeDb = {
    closed: false,
    close: () => {
      db.closed = true;
    },
    onversionchange: null,
    onclose: null,
    objectStoreNames: { contains: () => true },
  };
  return db;
}

/** Hands back the request so a test can fire the event it wants, in its own order. */
function fakeFactory() {
  return {
    open: vi.fn(() => {
      const req: FakeRequest = {
        result: makeDb(),
        error: null,
        onupgradeneeded: null,
        onsuccess: null,
        onerror: null,
        onblocked: null,
      };
      opens.push(req);
      return req;
    }),
  };
}

beforeEach(() => {
  opens = [];
  vi.stubGlobal("indexedDB", fakeFactory());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("createIdbHandle", () => {
  it("opens once and reuses the connection", async () => {
    const handle = createIdbHandle("db", 1, () => undefined);
    const first = handle.open();
    const second = handle.open();
    opens[0]?.onsuccess?.();

    expect(await first).toBe(await second);
    expect(opens).toHaveLength(1);
  });

  it("runs the upgrade callback with the database being upgraded", async () => {
    const upgrade = vi.fn();
    const handle = createIdbHandle("db", 1, upgrade);
    const open = handle.open();
    opens[0]?.onupgradeneeded?.();
    opens[0]?.onsuccess?.();
    await open;

    expect(upgrade).toHaveBeenCalledTimes(1);
    expect(upgrade).toHaveBeenCalledWith(opens[0]?.result);
  });

  it("closes and forgets the connection when another context asks for an upgrade", async () => {
    const handle = createIdbHandle("db", 1, () => undefined);
    const open = handle.open();
    opens[0]?.onsuccess?.();
    const db = (await open) as unknown as FakeDb;

    // The other context's `open(v2)` fires this. Without it, that upgrade sits in
    // `blocked` forever and its caller's promise never settles.
    db.onversionchange?.();
    expect(db.closed).toBe(true);

    // ...and the next caller must get a FRESH connection, not the closed one.
    const reopened = handle.open();
    opens[1]?.onsuccess?.();
    expect(await reopened).not.toBe(db);
    expect(opens).toHaveLength(2);
  });

  it("forgets the connection when the browser closes it (eviction, clear site data)", async () => {
    const handle = createIdbHandle("db", 1, () => undefined);
    const open = handle.open();
    opens[0]?.onsuccess?.();
    const db = (await open) as unknown as FakeDb;

    db.onclose?.();

    const reopened = handle.open();
    opens[1]?.onsuccess?.();
    expect(await reopened).not.toBe(db);
  });

  it("makes a blocked upgrade audible instead of hanging silently", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const handle = createIdbHandle("emojery-history", 2, () => undefined);
    void handle.open();

    opens[0]?.onblocked?.();
    await settle();

    expect(error).toHaveBeenCalledWith("[emojery:error]", expect.objectContaining({ scope: "idb.blocked", message: expect.stringContaining("emojery-history") }));
  });

  it("does not memoize a failed open, so the next call can succeed", async () => {
    const handle = createIdbHandle("db", 1, () => undefined);
    const failed = handle.open();
    if (opens[0]) opens[0].error = new DOMException("quota", "QuotaExceededError");
    opens[0]?.onerror?.();
    await expect(failed).rejects.toBeTruthy();

    const retry = handle.open();
    opens[1]?.onsuccess?.();
    await expect(retry).resolves.toBeTruthy();
    expect(opens).toHaveLength(2);
  });
});

// The transaction runner's three exits, against a fake transaction: the event
// wiring is what is under test, and a real IndexedDB cannot be told to abort
// without an error on demand. Real reads and writes are covered by the two
// stores' browser suites.
describe("runTransaction", () => {
  interface FakeTx {
    error: DOMException | null;
    oncomplete: (() => void) | null;
    onerror: (() => void) | null;
    onabort: (() => void) | null;
  }

  function fakeDb(): { db: IDBDatabase; tx: FakeTx; store: IDBObjectStore } {
    const tx: FakeTx = { error: null, oncomplete: null, onerror: null, onabort: null };
    const store = { name: "s" } as unknown as IDBObjectStore;
    const db = { transaction: () => Object.assign(tx, { objectStore: () => store }) } as unknown as IDBDatabase;
    return { db, tx, store };
  }

  it("resolves with the thunk's value once the transaction completes", async () => {
    const { db, tx, store } = fakeDb();
    let seen: IDBObjectStore | null = null;
    const done = runTransaction(db, "s", "readonly", "aborted", (s) => {
      seen = s;
      return () => 42;
    });
    tx.oncomplete?.();
    await expect(done).resolves.toBe(42);
    expect(seen).toBe(store);
  });

  it("rejects with the transaction's own error, and with the abort message when there is none", async () => {
    const failed = fakeDb();
    const failing = runTransaction(failed.db, "s", "readwrite", "aborted", () => () => undefined);
    failed.tx.error = new DOMException("quota", "QuotaExceededError");
    failed.tx.onerror?.();
    await expect(failing).rejects.toMatchObject({ name: "QuotaExceededError" });

    const aborted = fakeDb();
    const aborting = runTransaction(aborted.db, "s", "readwrite", "history push aborted", () => () => undefined);
    aborted.tx.onabort?.();
    await expect(aborting).rejects.toMatchObject({ message: "history push aborted" });
  });

  it("lets `run` reject early through the handle it is given", async () => {
    const { db } = fakeDb();
    const guarded = runTransaction(db, "s", "readwrite", "aborted", (_store, reject) => {
      reject(new Error("vote queue full"));
      return () => undefined;
    });
    await expect(guarded).rejects.toThrow("vote queue full");
  });
});
