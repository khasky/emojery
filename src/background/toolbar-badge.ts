// SPDX-License-Identifier: GPL-3.0-or-later
//
// The per-tab toolbar badge: how many pickers the content script injected into
// THIS tab. Separate from toolbar-icon.ts, which picks the icon from the tab's
// URL - one is driven by a message from the page, the other by navigation.
//
// Also the fresh-install onboarding dot: a GLOBAL default badge ("●") set at
// install and cleared by the first queued vote. It owns the badge outright while
// it is owed - per-tab counts stand down (see setInjectedBadge), because a count
// painted over the dot would hide it on exactly the supported pages onboarding
// sends the user to. Clearing a tab's count ("" with a tabId) falls back to the
// global default on MV3 Chrome - on Firefox MV2 that fallback is not guaranteed,
// so the dot may stay masked on a supported tab there.
//
// Once the icon is pinned the dot PULSES: short bursts of spinner frames, spaced
// by an alarm, rather than one continuous animation. A continuous one would need
// the service worker awake for as long as the reminder stands, which is the whole
// thing MV3 exists to prevent; a burst runs well inside the worker's idle window
// and lets it die again. The budget is finite (PULSE_BURSTS) so an install that
// never reaches the first reaction settles back to a still dot instead of
// flashing forever - the LATCH still holds, only the motion is spent.
import { isOnboardingBadgeActive, isToolbarPinned, markToolbarPinned, readPulseBursts, setOnboardingBadgeActive, writePulseBursts } from "../shared/onboarding";
import { getSettings } from "../shared/settings";
import { clearAlarm, createAlarm, getToolbarUserSettings, setToolbarBadgeBackgroundColor, setToolbarBadgeText, setToolbarBadgeTextColor } from "../shared/webext";

const BADGE_BG = "#1877f2";
const BADGE_FG = "#ffffff";
const DOT = "●";

export const PULSE_ALARM = "onboarding-pulse";
// Equal-width frames on purpose: the badge pill sizes itself to its text, so a
// mixed-width cycle would make the icon jitter rather than pulse.
const PULSE_FRAMES = ["◐", "◓", "◑", "◒"] as const;
const PULSE_FRAME_MS = 300;
const PULSE_FRAMES_PER_BURST = 8;
const PULSE_PERIOD_MINUTES = 5;
// ~20 bursts is a couple of hours of active browsing - long enough to catch a
// user who wandered off mid-onboarding, short enough not to become furniture.
const PULSE_BURSTS = 20;

/** Badge text for a count. Chrome renders ~4 characters, so anything past 999 is "999+". */
export function formatBadgeCount(count: number): string {
  if (count <= 0) return "";
  if (count > 999) return "999+";
  return String(count);
}

// Mirrors the onboarding latch so the synchronous paint below can consult it.
// `undefined` = the worker has not read storage yet, which paints the count: that
// is what every install past onboarding does anyway, and the dot's own repaint is
// moments away.
let onboardingOwnsBadge: boolean | undefined;

export function setInjectedBadge(tabId: number, count: number): void {
  if (onboardingOwnsBadge) return;
  setToolbarBadgeText({ text: formatBadgeCount(count), tabId });
  setToolbarBadgeBackgroundColor({ color: BADGE_BG, tabId });
  setToolbarBadgeTextColor({ color: BADGE_FG, tabId });
}

export function clearInjectedBadge(tabId: number): void {
  setToolbarBadgeText({ text: "", tabId });
}

// No tabId: the dot is the browser-wide default badge, visible wherever no
// per-tab count overrides it.
function paintOnboardingDot(): void {
  setToolbarBadgeText({ text: DOT });
  setToolbarBadgeBackgroundColor({ color: BADGE_BG });
  setToolbarBadgeTextColor({ color: BADGE_FG });
}

/** Fresh install: latch the flag, seed the pulse budget and show the dot. */
export async function startOnboardingBadge(): Promise<void> {
  await setOnboardingBadgeActive(true);
  onboardingOwnsBadge = true;
  await writePulseBursts(PULSE_BURSTS);
  paintOnboardingDot();
}

/** Worker start: badge text does not survive a browser restart, so re-paint while the flag holds. */
export async function reassertOnboardingBadge(): Promise<void> {
  onboardingOwnsBadge = await isOnboardingBadgeActive();
  if (!onboardingOwnsBadge) return;
  paintOnboardingDot();
  await pulseOnboardingBadge();
}

/** First queued vote: the reminder has done its job - drop the flag, the pulse and the dot, for good. */
export async function finishOnboardingBadge(): Promise<void> {
  if (!(await isOnboardingBadgeActive())) return;
  await setOnboardingBadgeActive(false);
  onboardingOwnsBadge = false;
  clearAlarm(PULSE_ALARM);
  setToolbarBadgeText({ text: "" });
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One burst, then back to the still dot. Re-checks the latch between frames: the
 * user can react mid-burst, and a spinner frame landing after that would put the
 * retired dot back on the toolbar.
 */
async function playPulseBurst(): Promise<void> {
  for (let frame = 0; frame < PULSE_FRAMES_PER_BURST; frame++) {
    await wait(PULSE_FRAME_MS);
    if (!(await isOnboardingBadgeActive())) return;
    setToolbarBadgeText({ text: PULSE_FRAMES[frame % PULSE_FRAMES.length] });
  }
  await wait(PULSE_FRAME_MS);
  if (await isOnboardingBadgeActive()) paintOnboardingDot();
}

/**
 * The pin gate. The onboarding page latches the pin the moment its own poll sees
 * it; this is the fallback for the install whose checklist tab was closed first,
 * and it costs one API read per alarm tick. An engine without getUserSettings
 * (Firefox) can never answer, so the pulse never starts there and the still dot
 * stands - the same fallback the onboarding checklist makes for that step.
 */
async function pinnedNow(): Promise<boolean> {
  if (await isToolbarPinned()) return true;
  if ((await getToolbarUserSettings())?.isOnToolbar !== true) return false;
  await markToolbarPinned();
  return true;
}

/**
 * Spend one burst if everything still asks for it. Called on worker start, on the
 * pin landing, and on every alarm tick; each of those is a fresh worker as often
 * as not, so all the state comes from storage rather than memory.
 */
export async function pulseOnboardingBadge(): Promise<void> {
  if (!(await isOnboardingBadgeActive())) return;
  if (!(await pinnedNow())) return;
  const left = await readPulseBursts();
  const remaining = left ?? PULSE_BURSTS;
  if (remaining <= 0) return;
  // The one motion switch the worker can read: prefers-reduced-motion needs
  // matchMedia, which no service worker has.
  if (!(await getSettings()).reactionAnimations) return;
  await writePulseBursts(remaining - 1);
  if (remaining - 1 <= 0) clearAlarm(PULSE_ALARM);
  else createAlarm(PULSE_ALARM, { periodInMinutes: PULSE_PERIOD_MINUTES });
  await playPulseBurst();
}
