// SPDX-License-Identifier: GPL-3.0-or-later
//
// Popular reaction set for the picker's "Popular" row - read side. The canonical
// list is fetched from the API and cached in local storage (24h) by
// background/popular.ts. This content-script half keeps the latest list in memory
// so the picker fills the section *synchronously*, and picks up a background
// refresh only between opens. No fallback: while empty, the section is hidden.

import { storageLocalGet } from "./webext";

// Shared with background/popular.ts (the write side).
export const POPULAR_KEY = "popular_v1";
export const POPULAR_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredPopular {
  emojis: string[];
  fetchedAt: number;
}

const MAX_POPULAR = 300;
const MAX_EMOJI_BYTES = 64;
const encoder = new TextEncoder();

// Defensive cleaner for a list arriving from the network or storage: only
// non-empty, reasonably-short, unique strings, capped in count. Null when
// nothing usable survives, so callers keep their previous list.
export function sanitizePopular(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const emoji = candidate.trim();
    if (!emoji || seen.has(emoji)) continue;
    if (encoder.encode(emoji).length > MAX_EMOJI_BYTES) continue;
    seen.add(emoji);
    out.push(emoji);
    if (out.length >= MAX_POPULAR) break;
  }
  return out.length > 0 ? out : null;
}

let cachedPopular: string[] = [];
let primed = false;

export function getPopularSync(): string[] {
  return cachedPopular;
}

function applyStored(emojis: unknown): void {
  const clean = sanitizePopular(emojis);
  if (clean) cachedPopular = clean;
}

// Warm `cachedPopular` from storage and keep it tracking background refreshes.
// Idempotent per content script. Never fetches - the background refreshes and
// writes storage; the onChanged listener below propagates it here.
export async function primePopular(): Promise<void> {
  if (primed) return;
  primed = true;
  try {
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area !== "local") return;
      const change = changes[POPULAR_KEY];
      if (change) applyStored((change.newValue as StoredPopular | undefined)?.emojis);
    });
  } catch {
    // storage.onChanged unavailable - `cachedPopular` just won't live-track; fine.
  }
  try {
    const stored = await storageLocalGet([POPULAR_KEY]);
    applyStored((stored[POPULAR_KEY] as StoredPopular | undefined)?.emojis);
  } catch {
    // Keep whatever `cachedPopular` already holds.
  }
}
