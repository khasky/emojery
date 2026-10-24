// SPDX-License-Identifier: GPL-3.0-or-later
//
// Firefox's data-collection consent, which covers only the REQUIRED categories this build
// declares: the extension collects no analytics, so there is nothing optional to ask for.

import { permissionsGetAll } from "./webext";

type DataConsentManifest = chrome.runtime.Manifest & {
  browser_specific_settings?: {
    gecko?: {
      data_collection_permissions?: {
        required?: string[];
      };
    };
  };
};

function runtimeManifest(): DataConsentManifest | undefined {
  return (
    globalThis as typeof globalThis & {
      chrome?: { runtime?: { getManifest?: () => DataConsentManifest } };
    }
  ).chrome?.runtime?.getManifest?.();
}

function declaresDataCollection(): boolean {
  return (runtimeManifest()?.browser_specific_settings?.gecko?.data_collection_permissions?.required ?? []).length > 0;
}

// Firefox gained the built-in data-collection consent screen in 140 (Android 142); before that
// `permissions.getAll()` answers without a `data_collection` key even though the manifest declares
// one. Those installs never saw a disclosure, so the extension owes them its own - AMO requires it
// of any add-on whose floor sits below 140. The manifest check keeps this false on Chromium and
// Safari builds, where the key is absent by construction rather than by browser age.
export async function needsLegacyDataConsentNotice(): Promise<boolean> {
  if (!declaresDataCollection()) return false;
  const permissions = await permissionsGetAll().catch(() => null);
  return permissions !== null && !permissions.data_collection;
}
