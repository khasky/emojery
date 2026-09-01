// SPDX-License-Identifier: GPL-3.0-or-later
//
// Composable observer plugins for createScanObserver.
import { forEachOpenShadowRoot } from "../shared/dom-query";
import { isOnlyOwnMutations, type ObserverPlugin } from "./scan-observer";

export function shadowRootDiscovery(opts: { attributeFilter: readonly string[] }): ObserverPlugin {
  return {
    attach({ trigger }) {
      const observedRoots = new WeakSet<ParentNode>();
      // Added subtrees awaiting the shadow-root walk. Discovery is a full `*` walk per added
      // node, so it runs in its own task instead of inside the observer callback, and a burst
      // of batches (a feed page appending cards) is walked once rather than per batch.
      let pendingScopes: Element[] = [];
      let discoveryTimer = 0;
      const scheduleDiscovery = (): void => {
        if (discoveryTimer) return;
        discoveryTimer = window.setTimeout(() => {
          discoveryTimer = 0;
          const scopes = [...new Set(pendingScopes)];
          pendingScopes = [];
          for (const scope of scopes) {
            if (!scope.isConnected) continue;
            // A pending ancestor's walk covers this scope - don't walk it twice.
            if (scopes.some((other) => other !== scope && other.contains(scope))) continue;
            observeOpenShadowRoots(scope);
          }
        }, 0);
      };
      const observer = new MutationObserver((mutations) => {
        // Same self-amplification guard the main scan observer applies: without it every
        // trigger this plugin's own re-scan mounts fed another batch straight back into
        // trigger(), so the scan loop never went idle on a shadow-DOM site.
        if (isOnlyOwnMutations(mutations)) return;
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node instanceof Element) pendingScopes.push(node);
          }
        }
        if (pendingScopes.length > 0) scheduleDiscovery();
        trigger();
      });
      function observeRoot(scope: ParentNode): void {
        if (observedRoots.has(scope)) return;
        observedRoots.add(scope);
        observer.observe(scope, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: [...opts.attributeFilter],
        });
      }
      function observeOpenShadowRoots(scope: ParentNode): void {
        if (scope instanceof Element && scope.shadowRoot) observeRoot(scope.shadowRoot);
        forEachOpenShadowRoot(scope, (root) => {
          observeRoot(root);
          observeOpenShadowRoots(root);
        });
      }
      observeRoot(document.body);
      observeOpenShadowRoots(document.body);
      return () => {
        observer.disconnect();
        if (discoveryTimer) window.clearTimeout(discoveryTimer);
      };
    },
  };
}

// Re-scan on a client-side (pushState) navigation. SPAs like Instagram swap
// content with `history.pushState` - no popstate, and often no childList
// mutation once the new surface settles - so a URL change can leave the picker
// un-mounted. Polls the pathname, so a post's `?img_index=` image swipe is
// ignored.
export function urlChangeRescan(opts: { pollMs?: number; settleMs?: readonly number[] } = {}): ObserverPlugin {
  const pollMs = opts.pollMs ?? 250;
  const settle = opts.settleMs ?? [0, 350, 800];
  return {
    attach({ trigger }) {
      let last = location.pathname;
      let poll = 0;

      const check = (): void => {
        const current = location.pathname;
        if (current === last) return;
        last = current;
        for (const delay of settle) {
          if (delay <= 0) trigger();
          else window.setTimeout(trigger, delay);
        }
      };

      // The timer runs only while the tab is VISIBLE. A hidden tab navigates for
      // nobody, and this is the extension's one always-on timer - it used to tick
      // for the life of every Instagram tab, foreground or not. Coming back checks
      // once immediately, so a pathname that changed while hidden is still caught.
      const start = (): void => {
        if (!poll) poll = window.setInterval(check, pollMs);
      };
      const stop = (): void => {
        if (poll) window.clearInterval(poll);
        poll = 0;
      };
      const onVisibilityChange = (): void => {
        if (document.hidden) {
          stop();
          return;
        }
        check();
        start();
      };

      if (!document.hidden) start();
      document.addEventListener("visibilitychange", onVisibilityChange);
      return () => {
        stop();
        document.removeEventListener("visibilitychange", onVisibilityChange);
      };
    },
  };
}

export function lazyHoverPriming(opts: { selector: string; delaysMs?: readonly number[] }): ObserverPlugin {
  const events = ["mouseover", "focusin"];
  const delays = opts.delaysMs ?? [0, 400];
  return {
    attach({ trigger }) {
      const onHover = (event: Event): void => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        if (!target.closest(opts.selector)) return;
        for (const delay of delays) {
          if (delay <= 0) trigger();
          else window.setTimeout(trigger, delay);
        }
      };
      for (const ev of events) document.addEventListener(ev, onHover, true);
      return () => {
        for (const ev of events) document.removeEventListener(ev, onHover, true);
      };
    },
  };
}
