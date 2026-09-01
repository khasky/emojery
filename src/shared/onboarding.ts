// SPDX-License-Identifier: GPL-3.0-or-later
//
// One-way onboarding latches in storage.local. Both are absent on installs that
// predate this feature, and absent means "off": an existing profile updating in
// must never grow a toolbar dot or a coach-mark it already outlived.

import { storageLocalGet, storageLocalRemove, storageLocalSet } from "./webext";

const COACH_SEEN_KEY = "coach_seen_v1";
const ONBOARDING_BADGE_KEY = "onboarding_badge_v1";

/**
 * Claim the one-time coach-mark: `true` exactly once per install, then latched.
 * get-then-set is not atomic across tabs, so two supported-site tabs racing their
 * first mount can both claim - the worst case is the tooltip showing twice at
 * the same moment, and either dismissal is final from then on.
 */
export async function claimCoachMark(): Promise<boolean> {
  const items = await storageLocalGet(COACH_SEEN_KEY);
  if (items[COACH_SEEN_KEY] === true) return false;
  await storageLocalSet({ [COACH_SEEN_KEY]: true });
  return true;
}

/** Latch the coach-mark as seen without showing it (a deep-link auto-open already taught the trigger). */
export async function markCoachSeen(): Promise<void> {
  await storageLocalSet({ [COACH_SEEN_KEY]: true });
}

/**
 * Drop every onboarding latch. A reinstall keeps extension storage - Chromium
 * preserves it for an unpacked extension re-added to the same profile, and
 * Firefox does the same for a temporary add-on - so without this the first run
 * of a reinstalled extension inherits the old install's progress: a coach-mark
 * that never shows again and a onboarding checklist that opens half ticked.
 */
export async function resetOnboardingLatches(): Promise<void> {
  await storageLocalRemove([COACH_SEEN_KEY, ONBOARDING_BADGE_KEY]);
}

/** Whether the fresh-install toolbar dot is still owed. Missing key = inactive. */
export async function isOnboardingBadgeActive(): Promise<boolean> {
  const items = await storageLocalGet(ONBOARDING_BADGE_KEY);
  return items[ONBOARDING_BADGE_KEY] === true;
}

export async function setOnboardingBadgeActive(active: boolean): Promise<void> {
  await storageLocalSet({ [ONBOARDING_BADGE_KEY]: active });
}

/**
 * `true` once a trigger has mounted on a real page. The coach-mark latch doubles
 * as that record: it is claimed by the FIRST mount of the install (or spent by a
 * deep-linked auto-open, which is also a mount), and never unset.
 */
export async function hasSeenTrigger(): Promise<boolean> {
  const items = await storageLocalGet(COACH_SEEN_KEY);
  return items[COACH_SEEN_KEY] === true;
}

/**
 * `true` once a vote has been queued. Read off the badge latch, which install
 * arms and the first queued vote retires - so the transition true -> false IS
 * the first reaction. An ABSENT key means the dot was never armed (a profile
 * older than the flag), which reads as "not reacted": the onboarding page only
 * opens on a fresh install, where install.ts arms it.
 */
export async function hasReactedOnce(): Promise<boolean> {
  const items = await storageLocalGet(ONBOARDING_BADGE_KEY);
  return items[ONBOARDING_BADGE_KEY] === false;
}

/**
 * Call `onChange` whenever either latch above moves. Returns an unsubscribe.
 * Storage events are the only live signal here - nothing polls for these two.
 */
export function watchOnboardingFlags(onChange: () => void): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return () => {};
  const listener = (changes: Record<string, unknown>, area: string): void => {
    if (area !== "local") return;
    if (COACH_SEEN_KEY in changes || ONBOARDING_BADGE_KEY in changes) onChange();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
