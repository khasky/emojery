// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import facebookAdapter from "../adapters/facebook";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: ["https://www.facebook.com/*", "https://m.facebook.com/*"],
  runAt: "document_idle",
  main: () => contentEntryMain(facebookAdapter),
});
