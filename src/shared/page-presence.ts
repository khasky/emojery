// SPDX-License-Identifier: GPL-3.0-or-later
//
// How the extension's own pages (popup, auth, onboarding) tell the background they
// are open, which is what the toolbar dot follows.
//
// A port rather than a storage flag or a tab query: the manifest carries no `tabs`
// permission, so the worker cannot ask which of its pages are open, and a port
// disconnects when its page goes away for ANY reason - closed, navigated, crashed,
// force-quit - where a flag the page clears on unload would strand the dot on the
// first time a page never got to clean up after itself.

/** Port name the background matches on. No payload ever travels this port; the connection IS the message. */
export const PAGE_PRESENCE_PORT = "emojery:page-open";

const RECONNECT_MS = 1000;

/**
 * Hold the port open for the life of the page. A disconnect means the worker was
 * recycled underneath a page that is still open, so reconnecting brings the dot
 * back with it; `connect` THROWING means the extension context itself is gone (an
 * update or a reload orphaned this page), and there is nothing left to reconnect
 * to - which is why the retry hangs off the disconnect and not off the catch.
 */
export function announcePageOpen(): void {
  if (typeof chrome === "undefined" || !chrome.runtime?.connect) return;
  const connect = (): void => {
    try {
      const port = chrome.runtime.connect({ name: PAGE_PRESENCE_PORT });
      port.onDisconnect.addListener(() => setTimeout(connect, RECONNECT_MS));
    } catch {}
  };
  connect();
}
