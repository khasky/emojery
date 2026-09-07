// SPDX-License-Identifier: GPL-3.0-or-later
//
// The per-tab toolbar badge: how many pickers the content script injected into
// THIS tab. Separate from toolbar-icon.ts, which picks the icon from the tab's
// URL - one is driven by a message from the page, the other by navigation.
//
// Also the dot ("●"): the GLOBAL default badge, carried for exactly as long as one
// of the extension's own pages is open - the popup, the auth page, the onboarding
// checklist. Those are the pages that talk about the toolbar, and the dot is what
// points back at it while one of them is up. Presence arrives as a port per page
// (shared/page-presence.ts) rather than a tab query, which the manifest has no
// `tabs` permission for.
//
// Global and per-tab badges are separate surfaces: a tab showing an injected count
// keeps showing it while the dot is up, and clearing that count ("" with a tabId)
// falls back to the dot on MV3 Chrome - on Firefox MV2 that fallback is not
// guaranteed, so the dot may stay masked on a supported tab there.
import { setToolbarBadgeBackgroundColor, setToolbarBadgeText, setToolbarBadgeTextColor } from "../shared/webext";

const BADGE_BG = "#1877f2";
const BADGE_FG = "#ffffff";
const DOT = "●";

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

// Keyed by port rather than counted: a disconnect that somehow fired twice would
// take the dot down while a second page still had it up.
const openPages = new Set<chrome.runtime.Port>();

// No tabId: the browser-wide default badge, visible wherever no per-tab value
// overrides it. With one: that tab only.
function paintDot(tabId?: number): void {
  const scope = tabId === undefined ? {} : { tabId };
  setToolbarBadgeText({ text: DOT, ...scope });
  setToolbarBadgeBackgroundColor({ color: BADGE_BG, ...scope });
  setToolbarBadgeTextColor({ color: BADGE_FG, ...scope });
}

/**
 * Show the dot for as long as this page holds its port. The set survives only in
 * this worker, which is the right lifetime: a recycled worker has no pages left to
 * account for, and each surviving page re-announces itself on its own disconnect.
 *
 * The page's OWN tab is painted separately from the global default, because the
 * navigation that loaded it has already left an empty per-tab value behind
 * (clearInjectedBadge on `status === "loading"`, which fires for extension pages
 * too) - and a per-tab empty string hides the global dot on the one tab the user
 * is looking at. Clearing that value again on disconnect hands the tab back to the
 * global default, whatever it is by then.
 */
export function trackExtensionPage(port: chrome.runtime.Port): void {
  openPages.add(port);
  paintDot();
  const tabId = port.sender?.tab?.id;
  if (tabId !== undefined) paintDot(tabId);
  port.onDisconnect.addListener(() => {
    openPages.delete(port);
    if (tabId !== undefined) clearInjectedBadge(tabId);
    if (openPages.size === 0) setToolbarBadgeText({ text: "" });
  });
}
