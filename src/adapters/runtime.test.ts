// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { HOST_CLASS } from "../shared/dom";
import { ancestors, closestAny, closestWithin, collapseWhitespace, compactElements, directChildSlot, firstAncestor, matchesAny, orderModalFirst, precedes, safeMatches, textOf } from "./runtime";
import { createScanObserver, isOnlyOwnMutations } from "./scan-observer";

function rec(partial: Partial<MutationRecord>): MutationRecord {
  return {
    type: "childList",
    addedNodes: [] as unknown as NodeList,
    removedNodes: [] as unknown as NodeList,
    target: document.body,
    ...partial,
  } as MutationRecord;
}

function ownHost(): HTMLElement {
  const el = document.createElement("span");
  el.className = HOST_CLASS;
  return el;
}

// A generic sentinel node - not a supported-site element, just "a page node".
function pageNode(): HTMLElement {
  return document.createElement("div");
}

describe("isOnlyOwnMutations", () => {
  it("suppresses a batch that only adds our own host", () => {
    expect(isOnlyOwnMutations([rec({ addedNodes: [ownHost()] as unknown as NodeList })])).toBe(true);
  });

  it("suppresses a batch that only removes our own host", () => {
    expect(isOnlyOwnMutations([rec({ removedNodes: [ownHost()] as unknown as NodeList })])).toBe(true);
  });

  it("triggers when a page node is added", () => {
    expect(isOnlyOwnMutations([rec({ addedNodes: [pageNode()] as unknown as NodeList })])).toBe(false);
  });

  it("triggers on a mixed batch (ours + a page node)", () => {
    expect(isOnlyOwnMutations([rec({ addedNodes: [ownHost()] as unknown as NodeList }), rec({ addedNodes: [pageNode()] as unknown as NodeList })])).toBe(false);
  });

  it("treats an empty batch as a real change (never suppress nothing)", () => {
    expect(isOnlyOwnMutations([])).toBe(false);
    expect(isOnlyOwnMutations([rec({})])).toBe(false);
  });

  it("triggers on an attribute mutation targeting a page node", () => {
    expect(isOnlyOwnMutations([rec({ type: "attributes", target: pageNode() })])).toBe(false);
  });

  it("suppresses an attribute mutation targeting our own host", () => {
    expect(isOnlyOwnMutations([rec({ type: "attributes", target: ownHost() })])).toBe(true);
  });
});

// Generic-element checks for the selector/text/order helpers every adapter
// builds on. Site-literal selectors against live DOM are e2e's job; these pin
// the helpers' own contracts (bad-selector resilience, dedup, ordering).
describe("selector helpers", () => {
  it("closestAny skips an invalid selector literal and keeps trying", () => {
    const parent = document.createElement("div");
    parent.className = "wanted";
    const child = document.createElement("span");
    parent.append(child);
    document.body.append(parent);
    expect(closestAny(child, [":invalid(", ".wanted"])).toBe(parent);
    expect(closestAny(child, [":invalid(", ".absent"])).toBe(null);
  });

  it("safeMatches returns false instead of throwing on a bad selector", () => {
    const el = document.createElement("div");
    el.className = "a";
    expect(safeMatches(el, ".a")).toBe(true);
    expect(safeMatches(el, ":invalid(")).toBe(false);
  });

  it("matchesAny needs only one selector to hit", () => {
    const el = document.createElement("div");
    el.className = "a";
    expect(matchesAny(el, [":invalid(", ".b", ".a"])).toBe(true);
    expect(matchesAny(el, [".b", ".c"])).toBe(false);
  });

  it("compactElements drops null/undefined and duplicates, preserving order", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    expect(compactElements(null, a, undefined, b, a)).toEqual([a, b]);
    expect(compactElements()).toEqual([]);
  });
});

describe("text and order helpers", () => {
  it("collapseWhitespace flattens runs and trims", () => {
    expect(collapseWhitespace("  a \n\t b  ")).toBe("a b");
    expect(collapseWhitespace("   ")).toBe("");
  });

  it("textOf reads collapsed text content", () => {
    const el = document.createElement("div");
    el.innerHTML = "<span> 12 </span>\n<span>likes</span>";
    expect(textOf(el)).toBe("12 likes");
  });

  it("precedes reflects document order", () => {
    const first = document.createElement("div");
    const second = document.createElement("div");
    document.body.append(first, second);
    expect(precedes(first, second)).toBe(true);
    expect(precedes(second, first)).toBe(false);
  });

  it("orderModalFirst front-loads dialog content, else returns the input as-is", () => {
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    const inModal = document.createElement("button");
    dialog.append(inModal);
    const onPage = document.createElement("button");
    document.body.append(dialog, onPage);

    expect(orderModalFirst([onPage, inModal])).toEqual([inModal, onPage]);
    const noModal = [onPage];
    expect(orderModalFirst(noModal)).toBe(noModal);
  });

  it("directChildSlot walks up to the row's direct child, null when outside the row", () => {
    const row = document.createElement("div");
    const slot = document.createElement("div");
    const deep = document.createElement("span");
    slot.append(deep);
    row.append(slot);
    document.body.append(row);

    expect(directChildSlot(deep, row)).toBe(slot);
    expect(directChildSlot(slot, row)).toBe(slot);
    expect(directChildSlot(document.createElement("i"), row)).toBe(null);
  });

  it("ancestors yields the start node first, then parents, capped at maxDepth NODES", () => {
    const grandparent = document.createElement("div");
    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.append(child);
    grandparent.append(parent);
    document.body.append(grandparent);

    expect([...ancestors(child, 3)]).toEqual([child, parent, grandparent]);
    expect([...ancestors(child, 1)]).toEqual([child]);
    expect([...ancestors(child, 0)]).toEqual([]);
    // Runs out of tree before the budget instead of yielding null.
    expect([...ancestors(grandparent, 10)].at(-1)).toBe(document.documentElement);
  });
});

// Generic sentinel elements (no fake supported-site DOM): the bounded upward walk
// behind GitLab's button group, GitHub's action <li> and X's action row. Live
// placement on each of those sites is verified by e2e.
describe("firstAncestor / closestWithin", () => {
  function chain(depth: number): { top: HTMLElement; leaf: HTMLElement } {
    const top = document.createElement("div");
    top.className = "top";
    let node = top;
    for (let i = 0; i < depth; i++) {
      const child = document.createElement("div");
      node.appendChild(child);
      node = child;
    }
    document.body.appendChild(top);
    return { top, leaf: node };
  }

  it("finds the element itself at 0 hops and an ancestor within the cap", () => {
    const { top, leaf } = chain(2);
    expect(closestWithin(top, ".top", 0)).toBe(top);
    expect(closestWithin(leaf, ".top", 2)).toBe(top);
  });

  it("gives up when the match sits beyond maxHops", () => {
    const { leaf } = chain(3);
    expect(closestWithin(leaf, ".top", 2)).toBeNull();
  });

  it("counts PARENT HOPS, so the cap is one shallower than the nodes it visits", () => {
    const { top, leaf } = chain(1);
    // 1 hop = self + parent. `ancestors` would need 2 for the same reach.
    expect(firstAncestor(leaf, 1, (node) => node === top)).toBe(top);
    expect(firstAncestor(leaf, 0, (node) => node === top)).toBeNull();
  });

  it("returns the NEAREST match, not the outermost", () => {
    const outer = document.createElement("div");
    outer.className = "hit";
    const inner = document.createElement("div");
    inner.className = "hit";
    const leaf = document.createElement("span");
    inner.appendChild(leaf);
    outer.appendChild(inner);
    document.body.appendChild(outer);
    expect(closestWithin(leaf, ".hit", 5)).toBe(inner);
  });

  it("stops at `bound` instead of matching something outside it", () => {
    const outside = document.createElement("div");
    outside.className = "row";
    const card = document.createElement("article");
    const leaf = document.createElement("span");
    card.appendChild(leaf);
    outside.appendChild(card);
    document.body.appendChild(outside);

    // Unbounded the page-level wrapper wins - that is the placement bug `bound` exists for.
    expect(closestWithin(leaf, ".row", 5)).toBe(outside);
    expect(firstAncestor(leaf, 5, (node) => matchesAny(node, [".row"]), card)).toBeNull();
  });

  it("treats an unparseable selector as a miss, not a throw", () => {
    const { leaf } = chain(1);
    expect(() => closestWithin(leaf, ":::nope", 3)).not.toThrow();
    expect(closestWithin(leaf, ":::nope", 3)).toBeNull();
  });
});

// Scan-orchestration contract with mocked scan/onUpdate callbacks (explicitly a
// unit concern per the testing rule) - what the page looks like never matters here.
describe("createScanObserver", () => {
  const TRIGGER_EVENT = "em-test-trigger";
  const NAV_EVENT = "em-test-nav";
  let teardown: (() => void) | null = null;

  afterEach(() => {
    teardown?.();
    teardown = null;
    vi.useRealTimers();
    history.replaceState(null, "", "/");
  });

  function makeObserver(overrides: Partial<Parameters<typeof createScanObserver>[0]> = {}) {
    const scan = vi.fn().mockReturnValue([]);
    const onUpdate = vi.fn();
    teardown = createScanObserver({ onUpdate, scan, debounceMs: 250, ...overrides });
    return { scan, onUpdate };
  }

  it("runs an initial scan after the debounce window", () => {
    vi.useFakeTimers();
    const { scan, onUpdate } = makeObserver();
    expect(onUpdate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(250);
    expect(scan).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith([]);
  });

  it("coalesces a burst of trigger events into one scan", () => {
    vi.useFakeTimers();
    const { onUpdate } = makeObserver({ triggerEvents: [TRIGGER_EVENT] });
    window.dispatchEvent(new Event(TRIGGER_EVENT));
    window.dispatchEvent(new Event(TRIGGER_EVENT));
    window.dispatchEvent(new Event(TRIGGER_EVENT));
    vi.advanceTimersByTime(250);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new Event(TRIGGER_EVENT));
    vi.advanceTimersByTime(250);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("holds the scan while the tab is hidden and catches up on visibilitychange", () => {
    vi.useFakeTimers();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    try {
      const { onUpdate } = makeObserver({ triggerEvents: [TRIGGER_EVENT] });
      window.dispatchEvent(new Event(TRIGGER_EVENT));
      vi.advanceTimersByTime(1_000);
      expect(onUpdate).not.toHaveBeenCalled();

      hidden.mockReturnValue(false);
      document.dispatchEvent(new Event("visibilitychange"));
      vi.advanceTimersByTime(250);
      expect(onUpdate).toHaveBeenCalledTimes(1);
    } finally {
      hidden.mockRestore();
    }
  });

  it("re-scans on a nav event only when the tracked URL actually changed", () => {
    vi.useFakeTimers();
    const { onUpdate } = makeObserver({ navKey: "href", navEvents: [NAV_EVENT] });
    vi.advanceTimersByTime(250); // initial scan
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Same URL: the SPA fired its nav event without moving - no scan.
    window.dispatchEvent(new Event(NAV_EVENT));
    vi.advanceTimersByTime(250);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    history.pushState(null, "", "/next-route");
    window.dispatchEvent(new Event(NAV_EVENT));
    vi.advanceTimersByTime(250);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("navAlwaysTrigger scans on every nav event regardless of the URL", () => {
    vi.useFakeTimers();
    const { onUpdate } = makeObserver({ navKey: "href", navAlwaysTrigger: true, navEvents: [NAV_EVENT] });
    vi.advanceTimersByTime(250);
    window.dispatchEvent(new Event(NAV_EVENT));
    vi.advanceTimersByTime(250);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it("teardown cancels the pending scan and detaches event listeners", () => {
    vi.useFakeTimers();
    const { onUpdate } = makeObserver({ triggerEvents: [TRIGGER_EVENT] });
    teardown?.();
    teardown = null;
    window.dispatchEvent(new Event(TRIGGER_EVENT));
    vi.advanceTimersByTime(1000);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it("primes a re-scan when a link matching linkPrimeSelectors is clicked", () => {
    vi.useFakeTimers();
    const link = document.createElement("a");
    link.className = "prime-me";
    document.body.append(link);
    const { onUpdate } = makeObserver({ linkPrimeSelectors: () => [".prime-me"] });
    vi.advanceTimersByTime(250); // initial scan
    expect(onUpdate).toHaveBeenCalledTimes(1);

    link.dispatchEvent(new Event("click", { bubbles: true }));
    vi.advanceTimersByTime(750); // 500ms prime delay + 250ms debounce
    expect(onUpdate).toHaveBeenCalledTimes(2);
    link.remove();
  });
});
