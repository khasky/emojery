// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared fixtures for the Vitest unit suite: a stateful, spyable `chrome.storage` stub,
// the Firefox data-consent manifest, and `fetch` stubbing. See src/test/chrome-shim.ts
// for how to pick between the two.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { storageGetKeys } from "./storage-keys";

type Items = Record<string, unknown>;

// A stateful chrome.storage area over a plain object. get/set/remove/clear are
// `vi.fn` spies (so tests can assert calls) that honour BOTH the callback and
// promise styles webext.ts's callChrome accepts. Reads reflect prior writes.
function storageArea(store: Items) {
  return {
    get: vi.fn((keys?: unknown, done?: (items: Items) => void) => {
      const out: Items = {};
      for (const key of storageGetKeys(Object.keys(store), keys)) if (key in store) out[key] = store[key];
      done?.(out);
      return Promise.resolve(out);
    }),
    set: vi.fn((items: Items, done?: () => void) => {
      Object.assign(store, items);
      done?.();
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[], done?: () => void) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
      done?.();
      return Promise.resolve();
    }),
    clear: vi.fn((done?: () => void) => {
      for (const key of Object.keys(store)) delete store[key];
      done?.();
      return Promise.resolve();
    }),
  };
}

interface FakeChrome {
  /** Live backing object for chrome.storage.local - seed or assert directly. */
  local: Items;
  sync: Items;
  session: Items;
}

interface FakeChromeOptions {
  local?: Items;
  sync?: Items;
  session?: Items;
  /** runtime.id (and the origin getURL derives). */
  id?: string;
  /** Replaces the packed default wholesale. */
  manifest?: Record<string, unknown>;
  /** When set, expose permissions.getAll resolving this data_collection list. */
  dataCollection?: string[];
}

// Install globalThis.chrome with stateful local+sync storage plus a runtime
// (id/getManifest/getURL) and, optionally, the Firefox permissions.getAll
// surface. Returns the live backing stores so a test can seed or assert on them.
export function installFakeChrome(options: FakeChromeOptions = {}): FakeChrome {
  const local: Items = { ...options.local };
  const sync: Items = { ...options.sync };
  const session: Items = { ...options.session };
  const id = options.id ?? "emojery-test";
  const chromeStub: Record<string, unknown> = {
    runtime: {
      id,
      lastError: undefined,
      // Nothing reads `update_url` anymore - debug.ts gates its request logging on
      // the build-time `__EM_DEBUG_LOG__` constant (wxt.config.ts), not the manifest.
      // The field stays only to keep the default shaped like a real store install.
      getManifest: () => options.manifest ?? { version: "0.0.0-test", update_url: "https://clients2.google.com/service/update2/crx" },
      getURL: (path: string) => `chrome-extension://${id}/${path}`,
    },
    storage: { local: storageArea(local), sync: storageArea(sync), session: storageArea(session) },
  };
  if (options.dataCollection) {
    chromeStub.permissions = {
      getAll: vi.fn().mockResolvedValue({ permissions: [], origins: [], data_collection: options.dataCollection }),
    };
  }
  // Via stubGlobal so `vi.unstubAllGlobals()` in a suite's afterEach really
  // removes the stub - a bare `globalThis.chrome =` assignment outlived tests.
  vi.stubGlobal("chrome", chromeStub);
  return { local, sync, session };
}

// The Firefox-only optional data-collection manifest. Spread it into a
// version-carrying manifest where getManifest() must also report a version.
export const firefoxDataConsentManifest = {
  browser_specific_settings: {
    gecko: {
      data_collection_permissions: {
        optional: ["technicalAndInteraction"],
      },
    },
  },
} as const;

// Merge a Firefox data-consent runtime + permissions.getAll onto the currently
// installed globalThis.chrome (leaving its storage intact). `dataCollection` is
// what permissions.getAll reports as granted.
export function stubFirefoxDataConsent(dataCollection: string[]): void {
  Object.assign(globalThis.chrome, {
    runtime: { getManifest: () => firefoxDataConsentManifest },
    permissions: {
      getAll: vi.fn().mockResolvedValue({ permissions: [], origins: [], data_collection: dataCollection }),
    },
  });
}

// Install a `fetch` stub and return the mock (assert calls, or refine it further
// with .mockResolvedValueOnce). Restore with vi.unstubAllGlobals in afterEach.
export function stubFetch(implementation: (...args: Parameters<typeof fetch>) => Promise<Response>): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(implementation);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// The [url, init] pair of a fetch-shaped mock's most recent call, typed once
// here so callers don't repeat an `as unknown as [string, RequestInit]` cast.
export function lastFetchCall(fetchMock: { mock: { calls: unknown[][] } }): [url: string, init: RequestInit] {
  return fetchMock.mock.calls.at(-1) as [url: string, init: RequestInit];
}

// A `fetch` stub that always resolves to one JSON (or raw-string) Response.
export function stubFetchJson(status: number, body: unknown = "", headers?: Record<string, string>): ReturnType<typeof vi.fn> {
  const init: ResponseInit = headers ? { status, headers } : { status };
  return stubFetch(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), init));
}

const EMOJI_DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/emoji-data");

// Stub the pair emoji-meta.ts resolves its locale files through at runtime -
// chrome.runtime.getURL + fetch - serving the REAL shipped `public/emoji-data`
// straight off disk. Returns the live list of locale keys fetched so far, in
// order, for tests that assert on WHICH locale got routed to. Restore with
// vi.unstubAllGlobals().
export function stubEmojiDataFetch(): string[] {
  const fetchedKeys: string[] = [];
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => path } });
  vi.stubGlobal("fetch", async (url: string) => {
    const key = String(url).match(/emoji-data\/([\w-]+)\.json$/)?.[1];
    if (!key) return { ok: false, json: async () => null } as unknown as Response;
    fetchedKeys.push(key);
    return { ok: true, json: async () => JSON.parse(readFileSync(resolve(EMOJI_DATA_DIR, `${key}.json`), "utf8")) } as unknown as Response;
  });
  return fetchedKeys;
}
