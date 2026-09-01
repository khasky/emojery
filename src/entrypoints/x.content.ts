// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import xAdapter from "../adapters/x";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: ["https://x.com/*", "https://www.x.com/*"],
  runAt: "document_idle",
  main: () => contentEntryMain(xAdapter),
});
