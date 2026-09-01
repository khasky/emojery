// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every injected host that carries the page's resolved light/dark palette as a
// `data-theme` attribute, re-stamped whenever shared/theme reports a change. One
// theme watcher for all of them, installed on the first registration.

import { getCurrentTheme, watchTheme } from "../shared/theme";

const themedHosts = new Set<HTMLElement>();
let themeWatcherInstalled = false;

function ensureThemeWatcher(): void {
  if (themeWatcherInstalled) return;
  themeWatcherInstalled = true;
  watchTheme((t) => {
    for (const el of themedHosts) el.setAttribute("data-theme", t);
  });
}

export function registerThemedHost(el: HTMLElement): void {
  ensureThemeWatcher();
  themedHosts.add(el);
  el.setAttribute("data-theme", getCurrentTheme());
}

export function forgetThemedHost(el: HTMLElement): void {
  themedHosts.delete(el);
}

/** Drop hosts that left the document; the watcher keeps a strong reference. */
export function pruneThemedHosts(): void {
  for (const el of themedHosts) {
    if (!el.isConnected) themedHosts.delete(el);
  }
}
