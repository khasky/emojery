// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import githubAdapter from "../adapters/github";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: ["https://github.com/*"],
  runAt: "document_idle",
  main: () => contentEntryMain(githubAdapter),
});
