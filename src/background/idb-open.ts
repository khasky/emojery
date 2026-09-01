// SPDX-License-Identifier: GPL-3.0-or-later
//
// One connection opener for both IndexedDB stores (history.ts, votequeue.ts).
//
// Shared for the second-context-wants-a-new-schema-version case, which is real in
// production: the popup's Debug tab (entrypoints/popup/popup-queue.tsx) opens the
// vote queue directly while the service worker holds both stores. Handled before
// the first VERSION bump ever needs it, because:
//   - without `onversionchange`, this context keeps its connection open and the
//     other context's upgrade sits in `blocked` forever;
//   - without `onblocked`, that wait is silent - `open()` never settles and every
//     later call awaits it; no deadline catches it (API_TIMEOUT_MS covers `fetch`,
//     not IndexedDB).
// So: release the connection when asked, drop the memo so the next call reopens,
// and make a block audible.

import { logBackgroundError } from "./debug";

interface IdbHandle {
  /** Open (or reuse) the connection. Reopens after a versionchange closed it. */
  open(): Promise<IDBDatabase>;
  /** Test seam: forget the memoized connection without closing it. */
  reset(): void;
}

export function createIdbHandle(dbName: string, version: number, upgrade: (db: IDBDatabase) => void): IdbHandle {
  let dbPromise: Promise<IDBDatabase> | null = null;

  const open = (): Promise<IDBDatabase> => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(dbName, version);
      req.onupgradeneeded = () => upgrade(req.result);
      // Another context holds an older-version connection and has not closed it.
      // The request stays pending; say so instead of hanging silently.
      req.onblocked = () => logBackgroundError("idb.blocked", new Error(`${dbName}: upgrade to v${version} is blocked by an open connection in another context`));
      req.onsuccess = () => {
        const db = req.result;
        // Someone else is upgrading: close, and forget the memo so the next caller
        // opens a fresh connection at the new version instead of reusing a dead one.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        // Eviction or a manual "Clear site data" also invalidates the handle.
        db.onclose = () => {
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
    }).catch((error: unknown) => {
      // A failed open must not be memoized: the next call gets to try again.
      dbPromise = null;
      throw error;
    });
    return dbPromise;
  };

  return {
    open,
    reset: () => {
      dbPromise = null;
    },
  };
}
