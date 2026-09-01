// SPDX-License-Identifier: GPL-3.0-or-later
//
// First-paint bootstrap shared by the extension's own pages (popup, auth, onboarding).
// The order is load-bearing: the static HTML ships an English <title> and no theme,
// so the localized title and the browser's own preference have to be stamped here,
// before the first paint - the stored Theme setting can only arrive after an async
// storage read. `lang` follows the UI locale (WCAG 3.1.1); a hardcoded "en" makes
// screen readers read localized text with English pronunciation rules.
import { getSettings } from "./storage";
import { applyDocumentTheme } from "./theme";

/** `followStoredTheme` is for pages with no Theme state of their own; the popup
 *  applies the stored setting from an effect instead. */
export function bootstrapPage(title: string, followStoredTheme = false): void {
  document.title = title;
  applyDocumentTheme("system");
  if (followStoredTheme) {
    void getSettings()
      .then((settings) => applyDocumentTheme(settings.theme))
      .catch(() => {});
  }
  if (typeof chrome !== "undefined" && chrome.i18n?.getUILanguage) {
    document.documentElement.lang = chrome.i18n.getUILanguage();
  }
}
