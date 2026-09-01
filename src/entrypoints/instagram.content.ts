// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import instagramAdapter from "../adapters/instagram";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: ["https://www.instagram.com/*", "https://instagram.com/*"],
  runAt: "document_idle",
  main: () => contentEntryMain(instagramAdapter),
});
