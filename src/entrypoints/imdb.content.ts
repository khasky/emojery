// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import imdbAdapter from "../adapters/imdb";
import { matchPatternsForSite } from "../shared/sites";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: matchPatternsForSite("imdb"),
  runAt: "document_idle",
  main: () => contentEntryMain(imdbAdapter),
});
