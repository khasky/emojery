// SPDX-License-Identifier: GPL-3.0-or-later
//
// Stateless DOM/string helpers shared by the adapters. The selector-list queries
// (`queryFirst` / `queryAll` / `queryAllDeep`) live in `shared/dom-query.ts`
// instead - the UI layer needs them too, and importing them from here made
// `ui/` depend on `adapters/`, against the layer direction. The stateful
// re-scan engine lives in `scan-observer.ts`.

export function closestAny<T extends Element = HTMLElement>(el: Element, selectors: readonly string[]): T | null {
  for (const selector of selectors) {
    try {
      const hit = el.closest<T>(selector);
      if (hit) return hit;
    } catch {}
  }
  return null;
}

export function safeMatches(el: Element, selector: string): boolean {
  try {
    return el.matches(selector);
  } catch {
    return false;
  }
}

export function matchesAny(el: Element, selectors: readonly string[]): boolean {
  return selectors.some((selector) => safeMatches(el, selector));
}

export function compactElements(...elements: Array<HTMLElement | null | undefined>): HTMLElement[] {
  const out: HTMLElement[] = [];
  for (const el of elements) {
    if (!el || out.includes(el)) continue;
    out.push(el);
  }
  return out;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function textOf(el: Element): string {
  return collapseWhitespace(el.textContent ?? "");
}

export function precedes(a: Element, b: Element): boolean {
  return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
}

export function orderModalFirst<T extends Element>(elements: T[]): T[] {
  const inModal: T[] = [];
  const rest: T[] = [];
  for (const el of elements) {
    if (el.closest('[role="dialog"]')) inModal.push(el);
    else rest.push(el);
  }
  return inModal.length === 0 ? elements : [...inModal, ...rest];
}

export function directChildSlot(el: HTMLElement, row: HTMLElement): HTMLElement | null {
  let node: HTMLElement | null = el;
  while (node && node.parentElement !== row) {
    node = node.parentElement;
  }
  return node && node.parentElement === row ? node : null;
}

// Bounded upward walk, yielding `el` ITSELF first and then its parents:
// `maxDepth` counts NODES VISITED (self-inclusive, like `closest()`), not parent
// hops. A walk that tests the PARENT while returning the child slot
// (`actionRowSlot`, Instagram's row/rail walks, Threads' headless row walk)
// counts hops instead and must keep its own loop - swapping it for this is an
// off-by-one in live placement.
export function* ancestors(el: HTMLElement, maxDepth: number): Generator<HTMLElement> {
  let node: HTMLElement | null = el;
  for (let visited = 0; visited < maxDepth && node; visited++) {
    yield node;
    node = node.parentElement;
  }
}

/**
 * Nearest self-or-ancestor `accept` answers for, searched no further than
 * `maxHops` parents above `el`, and never out of `bound` when one is given.
 *
 * The bounded counterpart of `closestAny`: an unbounded `closest()` keeps
 * climbing past a post card into a page-level wrapper, and a match there places
 * the trigger on the wrong unit. Leaving `bound` ends the search rather than
 * skipping the node - once the walk is outside the subtree, everything above it
 * is too.
 *
 * `maxHops` counts PARENT HOPS, not nodes visited, so it reads as the depth cap
 * the call sites mean; `ancestors` counts nodes, and that +1 is the off-by-one
 * every one of them used to carry its own copy of.
 */
export function firstAncestor(el: HTMLElement, maxHops: number, accept: (node: HTMLElement) => boolean, bound?: HTMLElement): HTMLElement | null {
  for (const node of ancestors(el, maxHops + 1)) {
    if (bound && !bound.contains(node)) return null;
    if (accept(node)) return node;
  }
  return null;
}

/** `firstAncestor` for the common case, one selector. Selector-invalid input is a
 *  miss, not a throw (`safeMatches`) - adapters build these from site markup. */
export function closestWithin(el: HTMLElement, selector: string, maxHops: number): HTMLElement | null {
  return firstAncestor(el, maxHops, (node) => safeMatches(node, selector));
}
