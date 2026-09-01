// SPDX-License-Identifier: GPL-3.0-or-later
//
// Minimal in-memory `chrome` WebExtension shim. Pick between this and src/test/fixtures.ts
// by CAPABILITY, not engine: this one stubs the seams the rendered UI reaches chrome.* through
// (shared/webext.ts, ui/messaging.ts's sendMessage, a background-shaped `auth:status` answer,
// bundled-English i18n); fixtures.ts trades that for `vi.fn` spies and the Firefox permissions surface.

import { AUTH_KEY, isAuthSessionLive } from "../shared/auth-session";
import { storageGetKeys } from "./storage-keys";

type Listener = (...args: unknown[]) => void;
type Store = Map<string, unknown>;
type Items = Record<string, unknown>;

export interface ChromeShimHandle {
  /** Live view of chrome.storage.local - assert/seed directly in a test. */
  local: Store;
  /** Fire a storage.onChanged event to registered listeners (e.g. to drive
   *  mount.ts's live enable/auth watchers from a test). */
  emitChanged: (area: "local" | "sync", changes: Record<string, { newValue?: unknown; oldValue?: unknown }>) => void;
  /** Remove the shim from globalThis. Call in afterEach. */
  uninstall: () => void;
}

// The token-less signed-in record respondAsBackground accepts: browser tests seed
// `{ [AUTH_KEY]: makeLiveAuthSession() }` instead of hand-copying the shape.
export function makeLiveAuthSession(): { userId: string; expiresAt: number } {
  return { userId: "u1", expiresAt: Date.now() + 86_400_000 };
}

// The background's message surface, reduced to the one call the rendered UI
// makes. `auth:status` has to be answered here: the picker resolves the signed-in
// account through the background (ui/messaging.ts activeUserId) rather than
// reading the token-bearing auth record itself, so a shim that answers
// `undefined` renders every per-account section empty. Mirrors getAuth's EXPIRY
// check only (background/identity.ts), not its record-shape check: a test can seed
// a token-less `{ userId, expiresAt }` here and still read as signed in.
function respondAsBackground(local: Store, msg: unknown): unknown {
  if (typeof msg !== "object" || msg === null || (msg as { type?: unknown }).type !== "auth:status") return undefined;
  const auth = local.get(AUTH_KEY) as { userId?: unknown; expiresAt?: unknown } | undefined;
  const live = typeof auth?.expiresAt === "number" && isAuthSessionLive(auth.expiresAt);
  const userId = live && typeof auth.userId === "string" && auth.userId ? auth.userId : null;
  return { type: "auth:status", authed: userId !== null, userId, email: null };
}

// A defaults object also seeds the result - a stored value overrides its entry.
function readKeys(store: Store, keys: unknown): Items {
  const defaults = typeof keys === "object" && keys !== null && !Array.isArray(keys) ? (keys as Items) : {};
  const out: Items = { ...defaults };
  for (const k of storageGetKeys(store.keys(), keys)) if (store.has(k)) out[k] = store.get(k);
  return out;
}

export function installChromeShim(
  initial: {
    local?: Items;
    /** Override the offline default ("") - e.g. a data: URL so the emoji-sprite
     *  probe / locale fetch resolve to a loadable asset in a real engine. */
    getURL?: (path: string) => string;
    /** The one tab `chrome.tabs.query({active:true})` answers with. Absent = no
     *  tab, which is what a popup opened over `chrome://` effectively sees. */
    activeTab?: { url?: string; id?: number };
    /** Answer a runtime message the background would handle. Consulted BEFORE
     *  the built-in `auth:status` reply, and only for what it answers - return
     *  undefined to fall through. */
    onMessage?: (msg: unknown) => unknown;
  } = {},
): ChromeShimHandle {
  const local: Store = new Map(Object.entries(initial.local ?? {}));
  // Never seeded: nothing under test reads `storage.sync`, but the AREA has to
  // exist so a `sync` storage.onChanged event has somewhere to come from.
  const sync: Store = new Map();
  const changedListeners = new Set<Listener>();

  // Each method supports BOTH calling styles webext.ts's callChrome accepts:
  // the callback (`done`) and a returned promise. Callback alone is enough.
  const makeArea = (store: Store) => ({
    get: (keys: unknown, cb?: (items: Items) => void) => {
      const value = readKeys(store, keys);
      cb?.(value);
      return Promise.resolve(value);
    },
    set: (items: Items, cb?: () => void) => {
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      cb?.();
      return Promise.resolve();
    },
    remove: (keys: string | string[], cb?: () => void) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
      cb?.();
      return Promise.resolve();
    },
    clear: (cb?: () => void) => {
      store.clear();
      cb?.();
      return Promise.resolve();
    },
  });

  const chromeShim = {
    runtime: {
      id: "emojery-test",
      // Read by webext.ts::runtimeError - keep it undefined so calls "succeed".
      lastError: undefined,
      // emoji-data/*.json resolves against the real files vite serves (English is
      // lazy-fetched, and the search/label tests need it); everything else stays
      // "offline" ("") so the sprite probe no-ops until a test overrides getURL.
      getURL: initial.getURL ?? ((path: string) => (path.startsWith("emoji-data/") ? new URL(`/public/${path}`, location.origin).href : "")),
      getManifest: () => ({ version: "0.0.0-test" }),
      sendMessage: (msg: unknown, cb?: (response?: unknown) => void) => {
        const response = initial.onMessage?.(msg) ?? respondAsBackground(local, msg);
        cb?.(response);
        return Promise.resolve(response);
      },
      onMessage: {
        // Registration only - nothing in the shim dispatches messages.
        addListener: () => {},
        removeListener: () => {},
      },
    },
    tabs: {
      query: (_queryInfo: unknown, cb?: (tabs: unknown[]) => void) => {
        const tabs = initial.activeTab ? [initial.activeTab] : [];
        cb?.(tabs);
        return Promise.resolve(tabs);
      },
    },
    storage: {
      local: makeArea(local),
      sync: makeArea(sync),
      onChanged: {
        addListener: (l: Listener) => changedListeners.add(l),
        removeListener: (l: Listener) => changedListeners.delete(l),
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = chromeShim;

  return {
    local,
    emitChanged: (area, changes) => {
      for (const l of changedListeners) l(changes, area);
    },
    uninstall: () => {
      delete (globalThis as { chrome?: unknown }).chrome;
    },
  };
}
