// SPDX-License-Identifier: GPL-3.0-or-later
//
// The user's synced preferences.

import type { SupportedSite } from "./adapter";
import { DEFAULT_EMOJI_SENTIMENT, type EmojiSentiment } from "./native-actions";
import { DEFAULT_SITE_TOGGLES } from "./sites";
import type { ThemePreference } from "./theme";
import { storageSyncGet, storageSyncSet } from "./webext";

export interface Settings {
  enabled: boolean;
  /**
   * Hide the native site button the picker conceptually replaces (Star on
   * GitHub, Like on Facebook, ...). Default off so users keep the native action;
   * adapters opt in by setting `nativeElement` on the insertion point.
   */
  replaceNative: boolean;
  reactionAnimations: boolean;
  /**
   * Palette for everything the extension paints. A content script resolves
   * "system" against the host page, the popup/auth pages against the browser.
   */
  theme: ThemePreference;
  /**
   * Mirror a picked emoji to the site's native control (Like/upvote/Star,
   * dislike/downvote) according to `emojiSentiment`; on Facebook an exact
   * emoji match picks the matching native reaction. Default off: pressing a
   * native button on the user's behalf is strictly opt-in.
   */
  autoTriggerNative: boolean;
  /**
   * User-arranged positive/negative emoji lists driving `autoTriggerNative`.
   * Everything not listed is neutral (never mirrored), so neutral is implicit
   * and the sync payload stays small.
   */
  emojiSentiment: EmojiSentiment;
  /**
   * Whether reaction submissions include coarse context for aggregate
   * breakdowns (country/city/language/browser/OS). Default-on locally;
   * Firefox also gates this on its optional data permission.
   */
  analyticsConsent: boolean;
  /**
   * Reveal the popup's Debug tab (the pending reaction queue and the flush
   * loop's state). Off by default, and shipped in every build - a user setting,
   * not a build mode.
   */
  debugMode: boolean;
  sites: Record<SupportedSite, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  replaceNative: false,
  reactionAnimations: true,
  theme: "system",
  autoTriggerNative: false,
  emojiSentiment: {
    positive: [...DEFAULT_EMOJI_SENTIMENT.positive],
    negative: [...DEFAULT_EMOJI_SENTIMENT.negative],
  },
  analyticsConsent: true,
  debugMode: false,
  sites: { ...DEFAULT_SITE_TOGGLES },
};

// storage.sync holds user-syncable data, so a stored field can be any JSON value
// (or a shape from another extension version). Every scalar is re-derived below
// rather than trusted from the spread.
function storedBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function storedTheme(value: unknown): ThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : DEFAULT_SETTINGS.theme;
}

function storedSites(value: unknown): Record<SupportedSite, boolean> {
  const stored = (value ?? {}) as Record<string, unknown>;
  // Sites only a newer version knows survive the round trip (the reason the
  // top-level spread survives too); the ones this version declares are re-derived.
  const sites = { ...stored } as unknown as Record<SupportedSite, boolean>;
  for (const site of Object.keys(DEFAULT_SETTINGS.sites) as SupportedSite[]) {
    sites[site] = storedBoolean(stored[site], DEFAULT_SETTINGS.sites[site]);
  }
  return sites;
}

/** Turn a raw `settings` value out of storage.sync into a full Settings. The
 *  content script's watcher resolves the same shape out of a storage.onChanged
 *  snapshot, so both paths answer identically. */
export function resolveSettings(raw: unknown): Settings {
  const storedSettings = raw as Partial<Settings> | undefined;
  const storedSentiment = storedSettings?.emojiSentiment;
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    // Every declared field is re-derived below, so this spread survives for one
    // reason: carrying through keys a NEWER version wrote, which setSettings
    // would otherwise strip from the synced payload on the next write.
    ...(storedSettings ?? {}),
    enabled: storedBoolean(storedSettings?.enabled, DEFAULT_SETTINGS.enabled),
    replaceNative: storedBoolean(storedSettings?.replaceNative, DEFAULT_SETTINGS.replaceNative),
    reactionAnimations: storedBoolean(storedSettings?.reactionAnimations, DEFAULT_SETTINGS.reactionAnimations),
    autoTriggerNative: storedBoolean(storedSettings?.autoTriggerNative, DEFAULT_SETTINGS.autoTriggerNative),
    analyticsConsent: storedBoolean(storedSettings?.analyticsConsent, DEFAULT_SETTINGS.analyticsConsent),
    debugMode: storedBoolean(storedSettings?.debugMode, DEFAULT_SETTINGS.debugMode),
    theme: storedTheme(storedSettings?.theme),
    sites: storedSites(storedSettings?.sites),
    // A stored list replaces the default wholesale (an emptied list must stay
    // empty, not re-inherit defaults); per-key so a missing side falls back.
    emojiSentiment: {
      positive: Array.isArray(storedSentiment?.positive) ? storedSentiment.positive : [...DEFAULT_SETTINGS.emojiSentiment.positive],
      negative: Array.isArray(storedSentiment?.negative) ? storedSentiment.negative : [...DEFAULT_SETTINGS.emojiSentiment.negative],
    },
  };
  return merged;
}

export async function getSettings(): Promise<Settings> {
  const stored = await storageSyncGet(["settings"]);
  return resolveSettings(stored.settings);
}

/** The one spelling of "should the extension mount on this site?" - the mount
 *  gate and the settings watcher must never answer it differently. */
export function isSiteEnabled(settings: Settings, site: SupportedSite): boolean {
  return settings.enabled && settings.sites[site];
}

/** Lay a patch over a full Settings. `sites` is the one field that must merge
 *  rather than replace - it is a record of per-site toggles and a patch carries
 *  only the ones that changed, so a plain spread would drop every other site.
 *  The one place that rule is written for patches; the storage write below and
 *  the popup's local mirror both route here. (The content script never patches -
 *  it reads whole snapshots via getSettings.) */
export function mergeSettings(base: Settings, patch: Partial<Settings>): Settings {
  return {
    ...base,
    ...patch,
    sites: { ...base.sites, ...(patch.sites ?? {}) },
  };
}

export async function setSettings(patch: Partial<Settings>): Promise<void> {
  await storageSyncSet({ settings: mergeSettings(await getSettings(), patch) });
}
