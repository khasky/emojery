// SPDX-License-Identifier: GPL-3.0-or-later
//
// Presence beacon on the extension's own homepage; the detection/deep-link contract
// it stamps for lives in shared/deep-link.ts. Runs at document_start so the marker
// is present before the page's own script polls for it. The host is shared/homepage.ts's
// to own (host_permissions in wxt.config.ts read it from there too); this is NOT a
// reaction target, so it does not run the mount pipeline (unlike the per-site
// <site>.content.ts scripts).
import { defineContentScript } from "wxt/utils/define-content-script";
import { BEACON_DATASET_KEY } from "../shared/deep-link";
import { HOMEPAGE_MATCH_PATTERN } from "../shared/homepage";

export default defineContentScript({
  matches: [HOMEPAGE_MATCH_PATTERN],
  runAt: "document_start",
  main: () => {
    try {
      document.documentElement.dataset[BEACON_DATASET_KEY] = chrome.runtime.getManifest().version;
    } catch {} // best-effort: if the stamp fails, the page just sees no extension
  },
});
