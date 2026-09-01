// SPDX-License-Identifier: GPL-3.0-or-later
//
// The four first-run steps and the listener that fires them. Production reaches
// every one of them through `installFreshInstallAuthReset` at the bottom.

import { needsLegacyDataConsentNotice } from "../shared/data-consent";
import { resetOnboardingLatches } from "../shared/onboarding";
import { clearCountsCache } from "../shared/storage";
import { createTab, executeScriptFiles, queryTabs } from "../shared/webext";
import { logBackgroundError } from "./debug";
import { clearAuth, clearPendingDeletion } from "./identity";
import { startOnboardingBadge } from "./toolbar-badge";

// Everything a reinstall must NOT inherit. Extension storage survives removing
// and re-adding an extension (Chromium for an unpacked one, Firefox for a
// temporary add-on), so a fresh install event has to wipe the last install's
// session AND its onboarding progress - otherwise the new install opens its
// onboarding checklist with steps already ticked by someone else's run.
export async function resetAuthOnFreshInstall(): Promise<void> {
  await clearAuth();
  await clearPendingDeletion();
  await clearCountsCache();
  await resetOnboardingLatches();
}

// Pre-140 Firefox shows no data-collection prompt of its own, so the first thing a fresh
// install there sees is our disclosure - before any page URL reaches the API. The auth page
// carries it (same card chrome, no second entrypoint); `?consent=1` swaps the sign-in form for
// the notice.
export async function openLegacyDataConsentNotice(): Promise<void> {
  if (!(await needsLegacyDataConsentNotice())) return;
  await createTab({ url: chrome.runtime.getURL("auth.html?consent=1") });
}

// The browser only auto-injects content scripts into pages loaded after the install, so
// a supported tab that was already open stays inert until the user reloads it - which
// reads as "installed, nothing happened". Replay the manifest's own content scripts into
// those tabs. Reading the script list from the manifest keeps this in step with whatever
// entrypoints the build shipped. Only `complete` tabs: a still-loading one gets the
// script from the browser itself, and injecting there would race it.
export async function injectIntoOpenTabs(): Promise<void> {
  for (const script of chrome.runtime.getManifest().content_scripts ?? []) {
    const files = script.js ?? [];
    if (!script.matches?.length || !files.length) continue;
    const tabs = await queryTabs({ url: script.matches, status: "complete" });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      // One unreachable tab (discarded, an error page that still matches) must not
      // cost the rest their injection.
      await executeScriptFiles(tab.id, files).catch((error: unknown) => logBackgroundError("injectIntoOpenTabs", error));
    }
  }
}

// Firefox marks a temporary (dev/e2e) add-on load in the install event; Chrome
// has no such field. A temporary load re-fires "install" on every browser
// start, and its onboarding tab would steal the active tab each time.
function isTemporaryInstall(details: chrome.runtime.InstalledDetails): boolean {
  return (details as { temporary?: boolean }).temporary === true;
}

// One first-run tab, never two: pre-140 Firefox owes the user the
// data-collection disclosure before anything else, so the consent tab wins and
// those installs skip the onboarding page entirely (a second tab on first run
// reads as spam, and consent must not be scrollable-past).
export async function openOnboardingPage(details: chrome.runtime.InstalledDetails): Promise<void> {
  if (isTemporaryInstall(details)) return;
  if (await needsLegacyDataConsentNotice()) return;
  await createTab({ url: chrome.runtime.getURL("onboarding.html") });
}

export function installFreshInstallAuthReset(): void {
  chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason !== "install") return;
    // Chained, not fired alongside: the reset clears the onboarding latches and
    // the arm below writes one of them, so running them in parallel would let
    // the wipe land last and leave the fresh install with no toolbar dot.
    void resetAuthOnFreshInstall()
      // The dot then survives until the first queued vote (background/api.ts).
      .then(() => startOnboardingBadge())
      .catch((error: unknown) => logBackgroundError("resetAuthOnFreshInstall", error));
    void openLegacyDataConsentNotice().catch((error: unknown) => logBackgroundError("openLegacyDataConsentNotice", error));
    void injectIntoOpenTabs().catch((error: unknown) => logBackgroundError("injectIntoOpenTabs", error));
    void openOnboardingPage(details).catch((error: unknown) => logBackgroundError("openOnboardingPage", error));
  });
}
