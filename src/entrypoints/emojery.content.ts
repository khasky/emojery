// SPDX-License-Identifier: GPL-3.0-or-later
//
// Presence beacon on the extension's own homepage; the detection/deep-link contract
// it stamps for lives in shared/deep-link.ts. Runs at document_start so the marker
// is present before the page's own script polls for it. emojery.app is already in host_permissions
// (wxt.config.ts, from shared/homepage.ts HOMEPAGE_MATCH_PATTERN); this is NOT a
// reaction target, so it does not run the mount pipeline (unlike the per-site
// <site>.content.ts scripts).
import { defineContentScript } from "wxt/utils/define-content-script";
import { BEACON_DATASET_KEY } from "../shared/deep-link";

export default defineContentScript({
  matches: ["https://emojery.app/*"],
  runAt: "document_start",
  main: () => {
    try {
      document.documentElement.dataset[BEACON_DATASET_KEY] = chrome.runtime.getManifest().version;
    } catch {} // best-effort: if the stamp fails, the page just sees no extension
  },
});
