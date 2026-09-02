// SPDX-License-Identifier: GPL-3.0-or-later
//
// The stateful scan-observer engine: one debounced, visibility-aware re-scan
// loop per adapter (mutation / nav / event triggers, own-mutation suppression,
// plugin attach + teardown). Built by `framework.ts`'s `observe()`.
import type { PickerInsertionPoint } from "../shared/adapter";
import { OWN_NODES_SELECTOR } from "../shared/dom";
import { closestAny } from "./runtime";

export interface ObserverPluginContext {
  /** Schedule a debounced re-scan. */
  trigger: () => void;
}
export interface ObserverPlugin {
  attach(ctx: ObserverPluginContext): () => void;
}

export interface ScanObserverOptions {
  onUpdate: (points: PickerInsertionPoint[]) => void;
  scan: () => PickerInsertionPoint[];
  /** Skip scan ticks entirely while true - no mounts, no reconcile. For
   *  URL-addressed overlays (Threads' /media lightbox) where the underlying
   *  page is unchanged and any mount churn is at best invisible and at worst
   *  a stale trigger the close leaves behind. Scans resume on the next trigger
   *  after it turns false (a pathname-change plugin covers leaving the URL). */
  suspendScan?: () => boolean;
  debounceMs?: number;
  attributeFilter?: readonly string[];
  navKey?: "pathname" | "href" | null;
  navAlwaysTrigger?: boolean;
  navEvents?: readonly string[];
  triggerEvents?: readonly string[];
  linkPrimeSelectors?: () => readonly string[];
  plugins?: readonly ObserverPlugin[];
}

function isOwnMutationNode(node: Node): boolean {
  if (!(node instanceof HTMLElement)) return false;
  // `closest` matches the node itself first, so it also covers "the node IS one of ours".
  return node.closest(OWN_NODES_SELECTOR) !== null || node.querySelector(OWN_NODES_SELECTOR) !== null;
}

// A mutation batch is "ours" only when every record is caused by our own trigger
// host being inserted/removed/re-parented (or an attribute we set on it). Any
// page-originated add/remove keeps the batch non-own, so it still schedules a
// re-scan. Shared with observer-plugins.ts (same guard on the shadow-root
// observer) and exercised directly in tests.
export function isOnlyOwnMutations(records: readonly MutationRecord[]): boolean {
  if (records.length === 0) return false;
  for (const rec of records) {
    if (rec.type === "childList") {
      // Ours only if it EXCLUSIVELY adds/removes our nodes. An empty batch is not
      // a mount, so treat it as a real change.
      if (rec.addedNodes.length === 0 && rec.removedNodes.length === 0) return false;
      for (const n of rec.addedNodes) {
        if (!isOwnMutationNode(n)) return false;
      }
      for (const n of rec.removedNodes) {
        if (!isOwnMutationNode(n)) return false;
      }
    } else if (!isOwnMutationNode(rec.target)) {
      return false;
    }
  }
  return true;
}

// The debounced scan defers to an idle slot when the engine offers one, but
// never past this cap - a busy feed would otherwise starve the scan forever.
const IDLE_SCAN_TIMEOUT_MS = 500;

// A click on a permalink-shaped link is the earliest navigation signal: re-check
// the URL shortly after (the SPA may not have committed it yet), then run the
// primed catch-up scan once the new surface has had time to render.
const LINK_NAV_CHECK_DELAY_MS = 50;
const LINK_PRIME_DELAY_MS = 500;

export function createScanObserver(opts: ScanObserverOptions): () => void {
  const { onUpdate, scan, suspendScan, debounceMs = 250, attributeFilter, navKey = null, navAlwaysTrigger = false, navEvents = [], triggerEvents = [], linkPrimeSelectors, plugins = [] } = opts;

  let scheduled = 0;
  let idleHandle = 0;
  // A hidden tab runs no scans: mutations mark this instead, and the catch-up
  // scan runs on the next visibilitychange back to visible.
  let pendingWhileHidden = false;
  let lastNav = navKey ? location[navKey] : "";

  const runScan = (): void => {
    if (document.hidden) {
      pendingWhileHidden = true;
      return;
    }
    if (suspendScan?.()) return;
    onUpdate(scan());
  };

  const trigger = (): void => {
    if (scheduled || idleHandle) return;
    if (document.hidden) {
      pendingWhileHidden = true;
      return;
    }
    scheduled = window.setTimeout(() => {
      scheduled = 0;
      if (typeof window.requestIdleCallback === "function") {
        idleHandle = window.requestIdleCallback(
          () => {
            idleHandle = 0;
            runScan();
          },
          { timeout: IDLE_SCAN_TIMEOUT_MS },
        );
      } else {
        runScan();
      }
    }, debounceMs);
  };

  const onVisibilityChange = (): void => {
    if (!document.hidden && pendingWhileHidden) {
      pendingWhileHidden = false;
      trigger();
    }
  };

  const onNav = (): void => {
    // `navAlwaysTrigger` skips the compare entirely, so `lastNav` is only ever read
    // on the path that also writes it.
    if (navAlwaysTrigger) {
      trigger();
      return;
    }
    if (!navKey) return;
    const current = location[navKey];
    if (current === lastNav) return;
    lastNav = current;
    trigger();
  };

  const onLinkClick = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element) || !linkPrimeSelectors) return;
    if (!closestAny(target, linkPrimeSelectors())) return;
    window.setTimeout(onNav, LINK_NAV_CHECK_DELAY_MS);
    window.setTimeout(trigger, LINK_PRIME_DELAY_MS);
  };

  // Ignore mutation batches caused solely by our own DOM writes (mounting/
  // moving/removing a trigger host): each mount is a childList mutation that
  // would otherwise schedule another scan, a self-amplifying loop on top of what
  // the page - or an ad blocker mutating the DOM continuously - is already doing.
  // Any batch that touches a page node still triggers, so new posts are not missed.
  const observer = new MutationObserver((records) => {
    // A scan is already pending (or queued behind a hidden tab): skip the
    // own-mutation walk entirely - it descends every added subtree and the
    // scheduled scan covers this batch anyway.
    if (scheduled || idleHandle || pendingWhileHidden) return;
    if (isOnlyOwnMutations(records)) return;
    trigger();
  });
  observer.observe(
    document.body,
    attributeFilter
      ? {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [...attributeFilter],
        }
      : { childList: true, subtree: true },
  );

  // Every listener registers through `listen`, so its removal is never forgotten -
  // a listener added without its pair silently outlives the content script.
  const listenerTeardowns: Array<() => void> = [];
  const listen = (target: EventTarget, type: string, handler: EventListener, capture = false): void => {
    target.addEventListener(type, handler, capture);
    listenerTeardowns.push(() => target.removeEventListener(type, handler, capture));
  };

  listen(document, "visibilitychange", onVisibilityChange);
  if (navKey) listen(window, "popstate", onNav);
  for (const ev of navEvents) listen(window, ev, onNav as EventListener);
  for (const ev of triggerEvents) listen(window, ev, trigger as EventListener);
  if (linkPrimeSelectors) listen(document, "click", onLinkClick, true);
  const pluginTeardowns = plugins.map((plugin) => plugin.attach({ trigger }));

  trigger();

  return () => {
    observer.disconnect();
    for (const teardown of pluginTeardowns) teardown();
    for (const teardown of listenerTeardowns) teardown();
    if (scheduled) window.clearTimeout(scheduled);
    if (idleHandle && typeof window.cancelIdleCallback === "function") {
      window.cancelIdleCallback(idleHandle);
    }
  };
}
