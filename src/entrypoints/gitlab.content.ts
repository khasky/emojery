// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import gitlabAdapter from "../adapters/gitlab";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: ["https://gitlab.com/*"],
  runAt: "document_idle",
  main: () => contentEntryMain(gitlabAdapter),
});
