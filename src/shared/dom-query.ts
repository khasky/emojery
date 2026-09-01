// SPDX-License-Identifier: GPL-3.0-or-later
//
// Selector-list DOM queries shared by the adapters and the UI layer. Every helper
// takes its root as an argument and reaches for no ambient one - no `document`, no
// `window`, no chrome.*; the shadow walk below reads the `NodeFilter` constant, which
// every DOM context defines. So this module stays safe to import from any of them.
//
// The query helpers walk a LIST of selector literals and swallow a selector the
// engine rejects, so one bad literal never kills the remaining ones.

export function queryFirst<T extends Element>(root: ParentNode, selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    try {
      const hit = root.querySelector<T>(selector);
      if (hit) return hit;
    } catch {}
  }
  return null;
}

export function queryAll<T extends Element>(root: ParentNode, selectors: readonly string[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();
  for (const selector of selectors) {
    try {
      for (const el of root.querySelectorAll<T>(selector)) {
        if (seen.has(el)) continue;
        seen.add(el);
        out.push(el);
      }
    } catch {}
  }
  return out;
}

// Visit every open shadow root directly under `scope`'s tree (not recursing
// into the roots themselves - the caller decides that). A TreeWalker instead of
// materializing `querySelectorAll("*")` into an array: shadow-root discovery
// runs per added subtree on feed sites, and the wildcard array was the single
// biggest allocation on that path.
export function forEachOpenShadowRoot(scope: ParentNode, visit: (root: ShadowRoot) => void): void {
  const doc = scope.ownerDocument ?? (scope as Document);
  if (typeof doc.createTreeWalker !== "function") return;
  const walker = doc.createTreeWalker(scope as Node, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const shadow = (node as Element).shadowRoot;
    if (shadow) visit(shadow);
  }
}

// `queryAll` that also descends into OPEN shadow roots (Reddit's post shells,
// and our own hosts when the UI re-reads what it mounted).
export function queryAllDeep<T extends Element>(root: ParentNode, selectors: readonly string[]): T[] {
  const out: T[] = [];
  const seen = new Set<T>();

  const visit = (scope: ParentNode): void => {
    for (const el of queryAll<T>(scope, selectors)) {
      if (seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    if (scope instanceof Element && scope.shadowRoot) {
      visit(scope.shadowRoot);
    }
    forEachOpenShadowRoot(scope, visit);
  };

  visit(root);
  return out;
}
