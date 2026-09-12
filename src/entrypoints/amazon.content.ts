// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import amazonAdapter from "../adapters/amazon";
import { matchPatternsForSite } from "../shared/sites";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: matchPatternsForSite("amazon"),
  runAt: "document_idle",
  main: () => contentEntryMain(amazonAdapter),
});
