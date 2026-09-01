// SPDX-License-Identifier: GPL-3.0-or-later
import type { SiteAdapter } from "../shared/adapter";
import { armReactHint } from "./deep-link";
import { mountAll, watchSettings } from "./mount";
import { preloadSiteStyle } from "./mount-style-memory";
import { handleVoteSyncMessage } from "./vote-sync";

// One isolated world per frame, shared by every copy of the script, so a flag on it
// settles the one case where two copies run: the fresh-install replay
// (background/install.ts) landing in a tab the browser also injected itself.
const ENTRY_FLAG = "__khaskyEmojeryEntered";

export function contentEntryMain(adapter: SiteAdapter): void {
  if (!adapter.matches(location.host)) return;
  const world = window as Window & { [ENTRY_FLAG]?: boolean };
  if (world[ENTRY_FLAG]) return;
  world[ENTRY_FLAG] = true;
  installVoteSyncListener();
  // Before the first scan, so the matching mount can consume the hint.
  armReactHint();
  // The emoji sheet is deliberately NOT preloaded here: ~1 MB, and this runs on every page
  // of every supported host. mount.ts starts it at the first settings-allowed mount (see schedulePendingMount).

  // Seeded before the first scan so a reload inherits the last blended look.
  void preloadSiteStyle(adapter.site);
  adapter.observe((points) => {
    mountAll(points);
  });
  watchSettings(adapter);
}

let voteSyncListenerInstalled = false;

function installVoteSyncListener(): void {
  if (voteSyncListenerInstalled) return;
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;
  voteSyncListenerInstalled = true;
  chrome.runtime.onMessage.addListener((msg, sender) => {
    handleVoteSyncMessage(msg, sender, chrome.runtime.id);
    return false;
  });
}
