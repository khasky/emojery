// SPDX-License-Identifier: GPL-3.0-or-later
//
// The per-tab toolbar badge: how many pickers the content script injected into
// THIS tab. Separate from toolbar-icon.ts, which picks the icon from the tab's
// URL - one is driven by a message from the page, the other by navigation.
//
// Also the fresh-install onboarding dot: a GLOBAL default badge ("●") set at
// install and cleared by the first queued vote. Per-tab injected counts paint
// over it, and clearing a tab's count ("" with a tabId) falls back to the
// global default on MV3 Chrome - on Firefox MV2 that fallback is not
// guaranteed, so the dot may stay masked on a supported tab there; its job is
// the tabs where nothing else reminds of the extension, which it keeps.
import { isOnboardingBadgeActive, setOnboardingBadgeActive } from "../shared/onboarding";
import { setToolbarBadgeBackgroundColor, setToolbarBadgeText, setToolbarBadgeTextColor } from "../shared/webext";

const BADGE_BG = "#1877f2";
const BADGE_FG = "#ffffff";

/** Badge text for a count. Chrome renders ~4 characters, so anything past 999 is "999+". */
export function formatBadgeCount(count: number): string {
  if (count <= 0) return "";
  if (count > 999) return "999+";
  return String(count);
}

export function setInjectedBadge(tabId: number, count: number): void {
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
  setToolbarBadgeText({ text: "●" });
  setToolbarBadgeBackgroundColor({ color: BADGE_BG });
  setToolbarBadgeTextColor({ color: BADGE_FG });
}

/** Fresh install: latch the flag and show the dot. */
export async function startOnboardingBadge(): Promise<void> {
  await setOnboardingBadgeActive(true);
  paintOnboardingDot();
}

/** Worker start: badge text does not survive a browser restart, so re-paint while the flag holds. */
export async function reassertOnboardingBadge(): Promise<void> {
  if (await isOnboardingBadgeActive()) paintOnboardingDot();
}

/** First queued vote: the reminder has done its job - drop the flag and the dot, for good. */
export async function finishOnboardingBadge(): Promise<void> {
  if (!(await isOnboardingBadgeActive())) return;
  await setOnboardingBadgeActive(false);
  setToolbarBadgeText({ text: "" });
}
