// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import redditAdapter from "../adapters/reddit";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: ["https://www.reddit.com/*", "https://reddit.com/*"],
  runAt: "document_idle",
  main: () => contentEntryMain(redditAdapter),
});
