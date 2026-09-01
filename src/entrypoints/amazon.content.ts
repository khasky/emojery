// SPDX-License-Identifier: GPL-3.0-or-later
import { defineContentScript } from "wxt/utils/define-content-script";
import amazonAdapter from "../adapters/amazon";
import { contentEntryMain } from "../ui/content-entry";

export default defineContentScript({
  matches: [
    "https://www.amazon.com/*",
    "https://www.amazon.co.uk/*",
    "https://www.amazon.de/*",
    "https://www.amazon.fr/*",
    "https://www.amazon.it/*",
    "https://www.amazon.es/*",
    "https://www.amazon.ca/*",
    "https://www.amazon.com.au/*",
    "https://www.amazon.co.jp/*",
    "https://www.amazon.in/*",
    "https://www.amazon.com.br/*",
    "https://www.amazon.com.mx/*",
  ],
  runAt: "document_idle",
  main: () => contentEntryMain(amazonAdapter),
});
