// SPDX-License-Identifier: GPL-3.0-or-later
//
// The popup shell's decisions, kept out of main.tsx so they can be asserted without
// rendering it: which view a stored value resolves to, and where a keyboard walk of
// the tab bar lands. Everything here is pure or touches only localStorage.

import type { I18nKey } from "../../shared/i18n";

// Every panel the popup can show, "debug" last because it is the one that is not a tab.
export const VIEWS = ["settings", "history", "account", "report", "debug"] as const;
export type View = (typeof VIEWS)[number];

// Declaration order IS the tab-bar order, and nextViewForKey walks this array - so the tab
// bar is rendered from it rather than from a second hand-ordered list. Debug is absent by
// design: five labels overflow the popup's 360px strip in the longer locales, so its opt-in
// control is an icon in the header (main.tsx) rather than a fifth tab.
export const TAB_VIEWS: readonly View[] = VIEWS.filter((view) => view !== "debug");

// Keyed by View (not a parallel array), so a new view fails to compile until it has a label.
// Debug reuses the Settings row's own label: both name the same thing, and one key keeps the
// header's toggle and the setting that reveals it from drifting apart per locale.
export const VIEW_LABEL_KEYS: Record<View, I18nKey> = {
  settings: "tabSettings",
  history: "tabHistory",
  account: "tabAccount",
  report: "tabReport",
  debug: "settingDebug",
};

// The popup is torn down on every close, so "which tab was I on" has to outlive
// the component. localStorage rather than chrome.storage because it reads
// SYNCHRONOUSLY: an async read paints Settings first and then jumps, which reads
// as the popup losing your place and finding it again.
const VIEW_KEY = "popup_view_v1";

// Stored input, so it is matched against the known views rather than trusted: a
// value left by an older build (or an edited profile) falls back to Settings
// instead of rendering an empty panel.
export function storedView(): View {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return isView(stored) ? stored : "settings";
  } catch {
    // A profile with storage blocked still gets a working popup, just no memory.
    return "settings";
  }
}

export function rememberView(next: View): void {
  try {
    localStorage.setItem(VIEW_KEY, next);
  } catch {
    // Same as storedView: remembering the tab is a convenience, never a hard failure.
  }
}

function isView(value: string | null): value is View {
  return value !== null && (VIEWS as readonly string[]).includes(value);
}

/** Where an arrow/Home/End press moves the tab bar's selection, or null for a key
 *  the tab bar does not own (which the caller must let bubble). Arrows wrap; the
 *  WAI-ARIA tabs pattern activates on move, so the caller both selects and focuses.
 *  `current` must be a tab - with the Debug panel open the caller passes the tab the
 *  roving tabindex sits on, since Debug itself is not in the strip. */
export function nextViewForKey(key: string, current: View): View | null {
  const index = TAB_VIEWS.indexOf(current);
  if (index < 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return TAB_VIEWS[(index + 1) % TAB_VIEWS.length] ?? null;
    case "ArrowLeft":
    case "ArrowUp":
      return TAB_VIEWS[(index - 1 + TAB_VIEWS.length) % TAB_VIEWS.length] ?? null;
    case "Home":
      return TAB_VIEWS[0] ?? null;
    case "End":
      return TAB_VIEWS[TAB_VIEWS.length - 1] ?? null;
    default:
      return null;
  }
}
