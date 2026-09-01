// SPDX-License-Identifier: GPL-3.0-or-later
//
// The content script's one settings read. Every consumer in the page goes
// through it: the mount burst (many points per scan), the vote path, and the
// auto-press engine - each of which used to issue its own `storage.sync` round
// trip, so a single pick paid three.

import { getSettings, type Settings } from "../shared/storage";
import { setThemePreference } from "../shared/theme";

// A scan mounts many points in one burst; re-reading settings per point would
// hit storage dozens of times for an answer that cannot change mid-burst. The
// settings watcher (ui/mount.ts) drops the slot the moment storage changes, so
// this is a burst coalescer, not a staleness window a popup toggle can hide in.
const SETTINGS_CACHE_TTL_MS = 1_000;

let settingsRead: { at: number; promise: Promise<Settings> } | null = null;

export function readContentSettings(): Promise<Settings> {
  const now = Date.now();
  if (settingsRead && now - settingsRead.at < SETTINGS_CACHE_TTL_MS) return settingsRead.promise;
  const promise = getSettings()
    // Every mount reads its theme through shared/theme, so the forced palette has to be in
    // place before the first picker renders - this read is the one gate they all pass.
    .then((settings) => {
      setThemePreference(settings.theme);
      return settings;
    })
    .catch((error) => {
      if (settingsRead?.promise === promise) settingsRead = null;
      throw error;
    });
  settingsRead = { at: now, promise };
  return promise;
}

/** Drop the cached read: the stored settings just changed (ui/mount.ts watchSettings). */
export function invalidateContentSettings(): void {
  settingsRead = null;
}
