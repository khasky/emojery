// SPDX-License-Identifier: GPL-3.0-or-later
//
// Background refresh for the picker's Popular reaction set (write side). The list
// comes from the API at most once per 24h, cached as `{ emojis, fetchedAt }` in local
// storage. Stale-while-revalidate: the content script serves the cached list instantly
// while this updates storage off the critical path, never awaited on a user path.

import { API_BASE } from "../shared/config";
import { POPULAR_KEY, POPULAR_TTL_MS, type StoredPopular, sanitizePopular } from "../shared/popular";
import { storageLocalGet, storageLocalSet } from "../shared/webext";
import { apiFetch, logBackgroundError } from "./debug";
import { extensionClientHeaders } from "./identity";

// Coalesce concurrent refreshes (startup + alarm can race) into one request.
let inflight: Promise<void> | null = null;

async function readStored(): Promise<StoredPopular | null> {
  try {
    const raw = await storageLocalGet([POPULAR_KEY]);
    const stored = raw[POPULAR_KEY] as StoredPopular | undefined;
    if (stored && Array.isArray(stored.emojis) && typeof stored.fetchedAt === "number") return stored;
  } catch (error) {
    // Treat an unreadable cache as missing, so refresh.
    logBackgroundError("readStoredPopular", error);
  }
  return null;
}

function isFresh(stored: StoredPopular | null): boolean {
  return stored !== null && Date.now() - stored.fetchedAt < POPULAR_TTL_MS;
}

// Safe to call often (background startup + a periodic alarm): no-ops when the
// cache is fresh; any network/parse failure leaves the previous cache untouched.
export async function ensurePopularFresh(): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    if (isFresh(await readStored())) return;
    try {
      const res = await apiFetch(`${API_BASE}/reactions/popular`, { method: "GET", headers: extensionClientHeaders() });
      if (!res.ok) return;
      const body = (await res.json()) as { emojis?: unknown };
      const emojis = sanitizePopular(body.emojis);
      if (!emojis) return;
      await storageLocalSet({
        [POPULAR_KEY]: { emojis, fetchedAt: Date.now() } satisfies StoredPopular,
      });
    } catch (error) {
      logBackgroundError("ensurePopularFresh", error);
    }
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}
