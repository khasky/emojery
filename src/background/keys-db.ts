// SPDX-License-Identifier: GPL-3.0-or-later
//
// The one IndexedDB database both key stores live in: the per-epoch vote-signing
// keys (epoch-keys.ts) and the per-provider account keys (account-keys.ts). One
// handle, so a version bump upgrades both stores in a single onupgradeneeded
// and neither module's open blocks the other's.

import { createIdbHandle } from "./idb-open";

// Exported so the browser test tears down the real database by name rather than by a
// retyped literal, which a rename would leave pointing at nothing.
export const KEYS_DB_NAME = "emojery-epoch-keys";
// v2 added the account-keys store; the epoch-key store is kept as it was.
const VERSION = 2;

export const EPOCH_KEYS_STORE = "keys";
export const EPOCH_KEYS_USER_INDEX = "userId";
export const ACCOUNT_KEYS_STORE = "account-keys";

export const keysDb = createIdbHandle(KEYS_DB_NAME, VERSION, (db) => {
  if (!db.objectStoreNames.contains(EPOCH_KEYS_STORE)) {
    const store = db.createObjectStore(EPOCH_KEYS_STORE, { keyPath: "id" });
    store.createIndex(EPOCH_KEYS_USER_INDEX, "userId", { unique: false });
  }
  if (!db.objectStoreNames.contains(ACCOUNT_KEYS_STORE)) {
    db.createObjectStore(ACCOUNT_KEYS_STORE, { keyPath: "provider" });
  }
});
