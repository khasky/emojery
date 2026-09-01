// SPDX-License-Identifier: GPL-3.0-or-later
import { defineBackground } from "wxt/utils/define-background";
import { scheduleFlush, VOTE_WAKE_ALARM } from "../background/api";
import { logBackgroundError } from "../background/debug";
import { migrateLegacyHistory } from "../background/history";
import { finishPendingDeletion } from "../background/identity";
import { installFreshInstallAuthReset } from "../background/install";
import { handleRuntimeMessage } from "../background/message-router";
import { ensurePopularFresh } from "../background/popular";
import { clearInjectedBadge, reassertOnboardingBadge } from "../background/toolbar-badge";
import { applyToolbarIconForTab } from "../background/toolbar-icon";
import { AUTH_KEY } from "../shared/auth-session";
import { clearCountsCache, LEGACY_OWN_REACTIONS_KEY, maybeSweepCountsCache } from "../shared/storage";
import { addAlarmListener, createAlarm, getTab, queryActiveTab, setUninstallURL, storageLocalRemove } from "../shared/webext";

// Opened by the browser when the extension is removed. First-party on purpose: a
// third-party form host would receive the user's IP and User-Agent at uninstall,
// which is not something the privacy policy discloses and not something an
// uninstalled extension should still be arranging.
const UNINSTALL_FEEDBACK_URL = "https://emojery.app/uninstall";

// Last-resort boundary: swallow anything that escapes a task's own handler and
// keep the worker running, tracing only in unpacked/dev builds.
function installFailureBoundary(): void {
  self.addEventListener("unhandledrejection", (event) => {
    logBackgroundError("unhandledrejection", event.reason);
  });
  self.addEventListener("error", (event) => {
    logBackgroundError("uncaught", event.error ?? event.message);
  });
}

export default defineBackground(() => {
  installFailureBoundary();
  installFreshInstallAuthReset();

  // Pre-account-scoping store carries no owner, so v2 never reads it - drop the orphaned key.
  void storageLocalRemove([LEGACY_OWN_REACTIONS_KEY]).catch((error: unknown) => logBackgroundError("dropLegacyOwnReactions", error));

  void setUninstallURL(UNINSTALL_FEEDBACK_URL).catch((error: unknown) => logBackgroundError("setUninstallURL", error));

  // Migrate pre-IndexedDB history before the first flush can confirm new rows,
  // so legacy rows keep their place in insertion order. No-ops once migrated.
  void migrateLegacyHistory()
    .catch((error: unknown) => logBackgroundError("migrateLegacyHistory", error))
    .finally(() => {
      void scheduleFlush();
    });

  void finishPendingDeletion().catch((error: unknown) => logBackgroundError("finishPendingDeletion", error));

  // Warm the Popular-emoji cache on every service-worker start; the alarm below
  // refreshes it in long-lived browsers. ensurePopularFresh no-ops while fresh.
  void ensurePopularFresh();

  // Badge text is session state, not profile state: re-paint the onboarding dot
  // after a browser restart while the first reaction is still owed.
  void reassertOnboardingBadge().catch((error: unknown) => logBackgroundError("reassertOnboardingBadge", error));

  // Expired read-cache entries are dead weight in storage.local (getCachedCounts already
  // ignores them). Swept on worker start rather than on an alarm of its own - the worker
  // starts often enough during use, and maybeSweepCountsCache throttles itself.
  void maybeSweepCountsCache().catch((error: unknown) => logBackgroundError("sweepCountsCache", error));

  // The vote-flush alarm is created/cleared by the queue itself (background/api.ts), so an
  // idle install has no vote-flush wake-up; only this 6h popular-refresh alarm fires.
  createAlarm("popular-refresh", { periodInMinutes: 360 });
  addAlarmListener((alarm) => {
    if (alarm.name === VOTE_WAKE_ALARM) void scheduleFlush();
    if (alarm.name === "popular-refresh") void ensurePopularFresh();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!(AUTH_KEY in changes)) return;
    void clearCountsCache().catch((error: unknown) => logBackgroundError("clearCountsCache", error));
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === "loading") clearInjectedBadge(tabId);
    if (changeInfo.status || changeInfo.url) applyToolbarIconForTab(tabId, tab.url);
  });

  chrome.tabs.onActivated.addListener(({ tabId }) => {
    void getTab(tabId)
      .then((tab) => {
        if (tab) applyToolbarIconForTab(tabId, tab.url);
      })
      // getTab absorbs its own failure, so only a throw from the paint lands here.
      // Named like every other startup chore rather than surfacing as a scope-less
      // "unhandledrejection" in the failure boundary above.
      .catch((error: unknown) => logBackgroundError("paintActivatedTabIcon", error));
  });

  // Paint the active tab on each service-worker wake - no nav/activation fires then.
  void queryActiveTab()
    .then((tab) => {
      if (tab?.id !== undefined) applyToolbarIconForTab(tab.id, tab.url);
    })
    .catch((error: unknown) => logBackgroundError("paintActiveTabIcon", error));

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
});
