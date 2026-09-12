// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import gitlabAdapter from "../adapters/gitlab";
import { matchPatternsForSite } from "../shared/sites";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: matchPatternsForSite("gitlab"),
  runAt: "document_idle",
  main: () => contentEntryMain(gitlabAdapter),
});
