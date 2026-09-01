// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import threadsAdapter from "../adapters/threads";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: ["https://threads.com/*", "https://www.threads.com/*"],
  runAt: "document_idle",
  main: () => contentEntryMain(threadsAdapter),
});
