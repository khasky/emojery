// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import youtubeAdapter from "../adapters/youtube";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: ["https://www.youtube.com/*", "https://youtube.com/*"],
  runAt: "document_idle",
  main: () => contentEntryMain(youtubeAdapter),
});
