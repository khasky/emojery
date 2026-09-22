// SPDX-License-Identifier: GPL-3.0-or-later
//
// The user's synced preferences.

import type { SupportedSite } from "./adapter";
import { DEFAULT_EMOJI_SENTIMENT, type EmojiSentiment } from "./native-actions";
import { DEFAULT_SITE_TOGGLES } from "./sites";
import type { ThemePreference } from "./theme";
import { storageLocalGet, storageLocalSet, storageSyncGet, storageSyncSet } from "./webext";

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
   * loop's state). Off by default, and shipped in every build - a user setting
   * the build mode does not control.
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
// (or a shape from another extension version). Every scalar below is re-derived
// from the raw value before use.
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

// --- where settings live ---------------------------------------------------
//
// Two keys, and the split is what keeps the content script out of the account's
// business. `settings` is the EFFECTIVE snapshot of whoever is signed in: one
// object, the shape every reader already watches, so the mount gate and the
// settings watcher are untouched by any of this. `settings_by_account` is the
// record each account keeps of what it changed - sparse, since a setting left
// alone is the default and belongs to nobody.
//
// The per-account records stay in storage.LOCAL while the effective snapshot goes
// on syncing as it always has. They are keyed by account id, and storage.sync
// passes through the browser vendor's service: what syncs today is a preferences
// blob naming nobody, and docs/permissions.md says so in as many words. Keeping
// that promise costs per-device records, which is what "settings follow the
// account" needs anyway - the switching happens on one device.
//
// The active account is named in a key of its own rather than read off the
// session record: that record carries the bearer token, and a content script has
// no business holding one (shared/auth-session.ts).

export const SETTINGS_KEY = "settings";
export const SETTINGS_BY_ACCOUNT_KEY = "settings_by_account_v1";
/** storage.local, written by background/identity.ts on every sign-in and sign-out. */
export const ACTIVE_ACCOUNT_KEY = "active_account_v1";
/** The bucket for "nobody is signed in": its own account, not a shared default. */
export const SIGNED_OUT_ACCOUNT = "";

type AccountSettings = Record<string, Partial<Settings>>;

function asAccountSettings(value: unknown): AccountSettings {
  if (typeof value !== "object" || value === null) return {};
  const out: AccountSettings = {};
  for (const [account, patch] of Object.entries(value as Record<string, unknown>)) {
    if (typeof patch === "object" && patch !== null) out[account] = patch as Partial<Settings>;
  }
  return out;
}

async function activeAccountKey(): Promise<string> {
  try {
    const stored = await storageLocalGet([ACTIVE_ACCOUNT_KEY]);
    const active = stored[ACTIVE_ACCOUNT_KEY];
    return typeof active === "string" ? active : SIGNED_OUT_ACCOUNT;
  } catch {
    return SIGNED_OUT_ACCOUNT;
  }
}

/** Only what this account moved off its default: a setting never touched is the
 *  default and stays that way for every account, including the ones made later. */
export function changedFromDefaults(settings: Settings): Partial<Settings> {
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings)) {
    const fallback = DEFAULT_SETTINGS[key as keyof Settings];
    if (JSON.stringify(value) !== JSON.stringify(fallback)) patch[key] = value;
  }
  return patch as Partial<Settings>;
}

async function withAccountSettings(account: string, patch: Partial<Settings>): Promise<AccountSettings> {
  const stored = await storageLocalGet([SETTINGS_BY_ACCOUNT_KEY]);
  const all = asAccountSettings(stored[SETTINGS_BY_ACCOUNT_KEY]);
  if (Object.keys(patch).length === 0) delete all[account];
  else all[account] = patch;
  return all;
}

/** The settings an account carries: its own record laid over the defaults. An
 *  account that has changed nothing - including one signing in here for the first
 *  time - gets the defaults, which is what "settings follow the account" means. */
export async function settingsForAccount(account: string): Promise<Settings> {
  const stored = await storageLocalGet([SETTINGS_BY_ACCOUNT_KEY]);
  return mergeSettings(resolveSettings(undefined), asAccountSettings(stored[SETTINGS_BY_ACCOUNT_KEY])[account] ?? {});
}

// The one-time move from "one set of settings on this device" to "one per account".
// Everything the device had becomes the record of whoever is signed in at that
// moment, so nobody's settings reset under them on upgrade; every account made
// later starts from the defaults. Writing the key even when there was nothing to
// carry is what makes this run once.
async function migrateOnce(): Promise<void> {
  const [byAccount, settings] = await Promise.all([storageLocalGet([SETTINGS_BY_ACCOUNT_KEY]), storageSyncGet([SETTINGS_KEY])]);
  if (byAccount[SETTINGS_BY_ACCOUNT_KEY] !== undefined) return;
  const carried = changedFromDefaults(resolveSettings(settings[SETTINGS_KEY]));
  await storageLocalSet({ [SETTINGS_BY_ACCOUNT_KEY]: Object.keys(carried).length > 0 ? { [await activeAccountKey()]: carried } : {} });
}

/** Make `account`'s settings the effective ones. Called on every sign-in and
 *  sign-out; the readers see one `settings` write and nothing else changes.
 *  The order matters: the account being LEFT is the one the migration carries,
 *  so it runs before the active key moves. */
export async function activateAccountSettings(account: string): Promise<void> {
  await migrateOnce();
  await storageLocalSet({ [ACTIVE_ACCOUNT_KEY]: account });
  await storageSyncSet({ [SETTINGS_KEY]: await settingsForAccount(account) });
}

export async function getSettings(): Promise<Settings> {
  const stored = await storageSyncGet([SETTINGS_KEY]);
  return resolveSettings(stored[SETTINGS_KEY]);
}

/** The one spelling of "should the extension mount on this site?" - the mount
 *  gate and the settings watcher must never answer it differently. */
export function isSiteEnabled(settings: Settings, site: SupportedSite): boolean {
  return settings.enabled && settings.sites[site];
}

/** Lay a patch over a full Settings. `sites` is the one field that must be
 *  merged: it is a record of per-site toggles and a patch carries only the ones
 *  that changed, so a plain spread would drop every other site.
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
  await migrateOnce();
  const next = mergeSettings(await getSettings(), patch);
  // Both halves, one write: the effective snapshot every reader already watches, and
  // the owning account's record of what it changed.
  const byAccount = await withAccountSettings(await activeAccountKey(), changedFromDefaults(next));
  await Promise.all([storageSyncSet({ [SETTINGS_KEY]: next }), storageLocalSet({ [SETTINGS_BY_ACCOUNT_KEY]: byAccount })]);
}
