// SPDX-License-Identifier: GPL-3.0-or-later
//
// The API retired this build: every route under a retired prefix answers
// `410 {"error":"client_outdated"}`. The background records it here the first time it sees
// one (background/api-client.ts); from then on the vote queue keeps its votes instead of
// sending them, a click on a reaction opens the update notice instead of voting, and the
// popup and the sign-in page tell the user to update. The record names the version that was
// retired: storage survives an update, so the new build reads someone else's record and
// goes back to work.

import { storageLocalGet, storageLocalSet } from "./webext";

export const CLIENT_OUTDATED_KEY = "client_outdated_v1";

function buildVersion(): string {
  return globalThis.chrome?.runtime?.getManifest?.().version ?? "";
}

export async function readClientOutdated(): Promise<boolean> {
  try {
    const stored = (await storageLocalGet([CLIENT_OUTDATED_KEY]))[CLIENT_OUTDATED_KEY];
    return typeof stored === "string" && stored === buildVersion();
  } catch {
    return false;
  }
}

export async function markClientOutdated(): Promise<void> {
  if (await readClientOutdated()) return;
  await storageLocalSet({ [CLIENT_OUTDATED_KEY]: buildVersion() });
}

const STORE_URLS = {
  chrome: "https://chromewebstore.google.com/detail/emojery/nlkebphkgappggophjobchogdmdiaajd",
  edge: "https://microsoftedge.microsoft.com/addons/detail/emojery/jbmbhihbhpnidhfmepifgkeblikjdpcp",
  firefox: "https://addons.mozilla.org/firefox/addon/emojery/",
} as const;

/** The store page this browser updates the extension from. */
export function storeUrl(userAgent: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): string {
  if (/\bFirefox\//.test(userAgent)) return STORE_URLS.firefox;
  if (/\bEdg\//.test(userAgent)) return STORE_URLS.edge;
  return STORE_URLS.chrome;
}
