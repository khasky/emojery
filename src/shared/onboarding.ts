// SPDX-License-Identifier: GPL-3.0-or-later
//
// One-way onboarding latches in storage.local. All of them are absent on installs
// that predate this feature, and absent means "off": an existing profile updating
// in must never grow a coach-mark or a checklist step it already outlived.

import { storageLocalGet, storageLocalRemove, storageLocalSet } from "./webext";

const COACH_SEEN_KEY = "coach_seen_v1";
// The first-reaction latch. Named for the toolbar dot it used to drive; the dot now
// follows the extension's open pages instead (background/toolbar-badge.ts), and the
// key is kept under its old name so an install part-way through onboarding does not
// lose its progress. Three states: absent = not in play, true = owed, false = done.
const FIRST_REACTION_KEY = "onboarding_badge_v1";
// The checklist's "spot the button" step, kept apart from the coach-mark latch
// on purpose: that one is spent by the FIRST mount of the install, including the
// ones the install replays into tabs nobody is looking at, which ticked the step
// for a button the user never saw. Three states, like the latch above:
// absent = not in play, false = armed (the checklist has been on screen), true =
// earned. ui/trigger-seen.ts decides when it is earned.
const TRIGGER_SEEN_KEY = "trigger_seen_v1";

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
 * Drop every onboarding latch. A fresh-install event does not imply fresh storage:
 * Chromium re-fires it on a profile whose data is still there (an unpacked build
 * loaded from the command line does it on every launch), and a dev or e2e Firefox
 * run re-installs its temporary add-on into the same profile. Without this, that
 * run inherits the last one's progress: a coach-mark that never shows again and a
 * checklist that opens half ticked. A real uninstall needs no help here - Chromium
 * clears the extension's storage on its own.
 */
export async function resetOnboardingLatches(): Promise<void> {
  await storageLocalRemove([COACH_SEEN_KEY, FIRST_REACTION_KEY, TRIGGER_SEEN_KEY]);
}

/** Whether the first reaction is still owed. Missing key = not in play. */
export async function isFirstReactionOwed(): Promise<boolean> {
  const items = await storageLocalGet(FIRST_REACTION_KEY);
  return items[FIRST_REACTION_KEY] === true;
}

/** Fresh install: put the first reaction in play, which is what the checklist ticks off. */
export async function armFirstReaction(): Promise<void> {
  await storageLocalSet({ [FIRST_REACTION_KEY]: true });
}

/** First queued vote. Guarded so a later vote cannot re-settle a latch already spent. */
export async function markReactedOnce(): Promise<void> {
  if (!(await isFirstReactionOwed())) return;
  await storageLocalSet({ [FIRST_REACTION_KEY]: false });
}

/** "off" = the checklist was never on screen, "armed" = waiting for a real look, "seen" = earned. */
export type TriggerSeenState = "off" | "armed" | "seen";

/** One read for all three states - the content script asks this on every page it mounts on. */
export async function readTriggerSeen(): Promise<TriggerSeenState> {
  const items = await storageLocalGet(TRIGGER_SEEN_KEY);
  const value = items[TRIGGER_SEEN_KEY];
  if (value === true) return "seen";
  return value === false ? "armed" : "off";
}

/**
 * Arm the step, from the onboarding page's first visible render. Nothing may tick
 * a checklist the user has not laid eyes on yet, so the page itself is what opens
 * the window. Idempotent: an already-earned step is not walked back by a second
 * visit to the page.
 */
export async function armTriggerSeen(): Promise<void> {
  if ((await readTriggerSeen()) !== "off") return;
  await storageLocalSet({ [TRIGGER_SEEN_KEY]: false });
}

/** Earn the step. Only ui/trigger-seen.ts calls this, and only once it has proof of a look. */
export async function markTriggerSeen(): Promise<void> {
  await storageLocalSet({ [TRIGGER_SEEN_KEY]: true });
}

/** `true` once a trigger has been on screen, in a focused tab, after the checklist was seen. */
export async function hasSeenTrigger(): Promise<boolean> {
  return (await readTriggerSeen()) === "seen";
}

/**
 * `true` once a vote has been queued: install arms the latch and the first queued
 * vote retires it, so the transition true -> false IS the first reaction. An ABSENT
 * key means it was never armed (a profile older than the flag), which reads as "not
 * reacted": the onboarding page only opens on a fresh install, where install.ts arms it.
 */
export async function hasReactedOnce(): Promise<boolean> {
  const items = await storageLocalGet(FIRST_REACTION_KEY);
  return items[FIRST_REACTION_KEY] === false;
}

/**
 * Call `onChange` whenever either checklist latch moves. Returns an unsubscribe.
 * Storage events are the only live signal here - nothing polls for these two.
 */
export function watchOnboardingFlags(onChange: () => void): () => void {
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return () => {};
  const listener = (changes: Record<string, unknown>, area: string): void => {
    if (area !== "local") return;
    if (TRIGGER_SEEN_KEY in changes || FIRST_REACTION_KEY in changes) onChange();
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}
