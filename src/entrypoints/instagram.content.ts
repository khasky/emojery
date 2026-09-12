// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import instagramAdapter from "../adapters/instagram";
import { matchPatternsForSite } from "../shared/sites";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: matchPatternsForSite("instagram"),
  runAt: "document_idle",
  main: () => contentEntryMain(instagramAdapter),
});
