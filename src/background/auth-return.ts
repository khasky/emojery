// SPDX-License-Identifier: GPL-3.0-or-later
//
// Where sign-in came from, so it can end where it started.
//
// The auth page opens in a tab of its own, which leaves the page the user was
// reacting on in the background. Signing in there casts the reaction the picker's
// gate is holding (ui/picker.tsx), so the last thing the journey needs is the user
// back on that page to watch it land - otherwise a first-time user finishes on a
// dead-end tab that says "you can close this".
//
// Only the ORIGIN tab's id and window are remembered, never its URL: the id is all
// the return needs, and storage.session is trusted-contexts-only but still storage.
// Tab ids are handed out monotonically per browser session, so a closed origin tab
// cannot be impersonated by a later one - a stale id simply fails to resolve.

import { focusWindow, getTab, removeTab, storageSessionGet, storageSessionRemove, storageSessionSet, updateTab } from "../shared/webext";
import { logBackgroundError } from "./debug";

const RETURN_TARGET_KEY = "auth_return_target_v1";

interface ReturnTarget {
  tabId: number;
  windowId?: number;
}

/** Called for every `auth:openTab`. A sender with no tab is the popup, which has no
 *  page to go back to - it CLEARS the marker rather than leaving an older one armed,
 *  so a popup sign-in never hijacks some tab the user abandoned an hour ago. */
export async function rememberAuthOrigin(sender: chrome.runtime.MessageSender): Promise<void> {
  const tabId = sender.tab?.id;
  if (tabId === undefined) {
    await storageSessionRemove([RETURN_TARGET_KEY]);
    return;
  }
  const windowId = sender.tab?.windowId;
  await storageSessionSet({ [RETURN_TARGET_KEY]: { tabId, ...(windowId === undefined ? {} : { windowId }) } satisfies ReturnTarget });
}

async function readAuthOrigin(): Promise<ReturnTarget | null> {
  const stored = await storageSessionGet([RETURN_TARGET_KEY]);
  const target = stored[RETURN_TARGET_KEY] as ReturnTarget | undefined;
  return typeof target?.tabId === "number" ? target : null;
}

/** Whether the auth page should offer to take the user back. Answered before the
 *  countdown starts, so a tab closed in the meantime still lands on the fallback
 *  copy - `returnToAuthOrigin` re-checks and reports its own failure. */
export async function hasAuthOrigin(): Promise<boolean> {
  const target = await readAuthOrigin();
  if (!target) return false;
  // getTab resolves null for a tab that is gone rather than throwing.
  return (await getTab(target.tabId)) !== null;
}

/** Activates the origin tab and closes the auth tab it was signed in from.
 *  `false` means the origin tab is gone - the auth tab is then left open, because
 *  closing the page the user is looking at with nowhere to send them is worse than
 *  the dead end it replaces. */
export async function returnToAuthOrigin(authTabId: number | undefined): Promise<boolean> {
  const target = await readAuthOrigin();
  if (!target) return false;
  const tab = await getTab(target.tabId);
  if (tab === null) {
    await storageSessionRemove([RETURN_TARGET_KEY]).catch(() => {});
    return false;
  }

  // Focus first, then activate: raising the window after the tab is already active
  // is a second visible jump on the way to the same place.
  if (target.windowId !== undefined) {
    await focusWindow(target.windowId).catch((error: unknown) => logBackgroundError("returnToAuthOrigin.focusWindow", error));
  }
  await updateTab(target.tabId, { active: true });
  await storageSessionRemove([RETURN_TARGET_KEY]).catch(() => {});

  // Last, and only once the user has somewhere to be: closing the auth tab is what
  // makes this a return rather than a detour with a leftover tab behind it.
  if (authTabId !== undefined) {
    await removeTab(authTabId).catch((error: unknown) => logBackgroundError("returnToAuthOrigin.removeTab", error));
  }
  return true;
}
