// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import githubAdapter from "../adapters/github";
import { matchPatternsForSite } from "../shared/sites";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: matchPatternsForSite("github"),
  runAt: "document_idle",
  main: () => contentEntryMain(githubAdapter),
});
