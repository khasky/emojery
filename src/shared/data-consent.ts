// SPDX-License-Identifier: GPL-3.0-or-later

import { getSettings } from "./storage";
import { type DataCollectionPermissions, permissionsGetAll, permissionsRemove, permissionsRequest } from "./webext";

const TECHNICAL_AND_INTERACTION_DATA = "technicalAndInteraction";

type DataConsentManifest = chrome.runtime.Manifest & {
  browser_specific_settings?: {
    gecko?: {
      data_collection_permissions?: {
        optional?: string[];
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

function declaresTechnicalAndInteractionData(): boolean {
  return (runtimeManifest()?.browser_specific_settings?.gecko?.data_collection_permissions?.optional ?? []).includes(TECHNICAL_AND_INTERACTION_DATA);
}

// Firefox gained the built-in data-collection consent screen in 140 (Android 142); before that
// `permissions.getAll()` answers without a `data_collection` key even though the manifest declares
// one. Those installs never saw a disclosure, so the extension owes them its own - AMO requires it
// of any add-on whose floor sits below 140. The manifest check keeps this false on Chromium and
// Safari builds, where the key is absent by construction rather than by browser age.
export async function needsLegacyDataConsentNotice(): Promise<boolean> {
  if (!declaresTechnicalAndInteractionData()) return false;
  const permissions = await permissionsGetAll().catch(() => null);
  return permissions !== null && !permissions.data_collection;
}

export async function technicalAndInteractionConsentGranted(): Promise<boolean> {
  if (!declaresTechnicalAndInteractionData()) return true;

  try {
    const permissions = await permissionsGetAll();
    return permissions?.data_collection?.includes(TECHNICAL_AND_INTERACTION_DATA) === true;
  } catch {
    return false;
  }
}

export async function effectiveAnalyticsConsent(localConsent: boolean): Promise<boolean> {
  if (!localConsent) return false;
  return technicalAndInteractionConsentGranted();
}

// The stored analytics toggle (default on when unset or unavailable), gated by the platform data-collection permission.
export async function resolveLocalAnalyticsConsent(): Promise<boolean> {
  let localConsent = true;
  try {
    localConsent = (await getSettings()).analyticsConsent !== false;
  } catch {
    // The "unavailable" half of the contract above: a failed settings read keeps
    // the default-on toggle, still gated by the platform permission check below.
  }
  return effectiveAnalyticsConsent(localConsent);
}

export function requestTechnicalAndInteractionConsent(): Promise<boolean> {
  if (!declaresTechnicalAndInteractionData()) return Promise.resolve(true);
  return permissionsRequest(dataCollectionRequest()).catch(() => false);
}

export function removeTechnicalAndInteractionConsent(): Promise<boolean> {
  if (!declaresTechnicalAndInteractionData()) return Promise.resolve(true);
  return permissionsRemove(dataCollectionRequest()).catch(() => false);
}

function dataCollectionRequest(): DataCollectionPermissions {
  return { data_collection: [TECHNICAL_AND_INTERACTION_DATA] };
}
