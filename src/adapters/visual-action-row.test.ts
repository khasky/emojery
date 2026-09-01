// SPDX-License-Identifier: GPL-3.0-or-later
//
// The unit half of the SHARED geometric action-row heuristic (see the module
// header for who routes through it and what a regression costs).
//
// Everything below is built from GENERIC divs/buttons with stamped boxes: this
// pins the module's own decision logic (slot count, size and variance
// filtering, boundary and depth limits, the hidden-placeholder index
// contract). It deliberately models NO supported site's markup - which row of
// which site the heuristic finds on a live page stays an e2e question.
import { afterEach, describe, expect, it } from "vitest";
import { HOST_CLASS } from "../shared/dom";
import { findVisualActionSlot, hasRenderableBox, isRenderableInPageLayout, isStructuralRoot, pageHasLayout } from "./visual-action-row";

// `box()` stamps an own property, and <body>/<html> are the two nodes the global
// setup does NOT recreate between tests - so a stamped layout would leak into
// the next test and make "no page layout" cases unreachable.
afterEach(() => {
  for (const el of [document.body, document.documentElement] as Array<Partial<HTMLElement>>) delete el.getBoundingClientRect;
});

// jsdom doesn't lay out, so stamp a fixed box on an element (same idiom as
// ui/mount-style.test.ts).
function box(el: HTMLElement, w: number, h: number, x = 0, y = 0): HTMLElement {
  el.getBoundingClientRect = () => ({ x, y, left: x, top: y, right: x + w, bottom: y + h, width: w, height: h, toJSON: () => ({}) }) as DOMRect;
  return el;
}

// Give the page a layout so `pageHasLayout()` is true - otherwise every entry
// point short-circuits and nothing below is exercised.
function layoutPage(): void {
  box(document.body, 1000, 800);
}

interface RowSpec {
  /** One entry per slot: the control's width, or `null` for a slot with no control at all. */
  widths: Array<number | null>;
  rowWidth?: number;
  rowHeight?: number;
  slotHeight?: number;
}

// A generic row: a parent <div> holding one <div> slot per entry, each wrapping
// a <button>. Returns the row and its buttons so a test can pick the one to
// resolve from.
function buildRow({ widths, rowWidth = 500, rowHeight = 40, slotHeight = 32 }: RowSpec): { row: HTMLElement; buttons: HTMLElement[] } {
  const row = box(document.createElement("div"), rowWidth, rowHeight);
  const buttons: HTMLElement[] = [];
  for (const width of widths) {
    const slot = box(document.createElement("div"), width ?? 0, slotHeight);
    if (width !== null) {
      const button = box(document.createElement("button"), width, slotHeight);
      slot.append(button);
      buttons.push(button);
    }
    row.append(slot);
  }
  document.body.append(row);
  return { row, buttons };
}

describe("pageHasLayout", () => {
  it("is false while nothing has been laid out", () => {
    expect(pageHasLayout()).toBe(false);
  });

  it("is true once the body reports a box", () => {
    layoutPage();
    expect(pageHasLayout()).toBe(true);
  });

  it("is true when only the documentElement reports a box", () => {
    box(document.documentElement, 1000, 800);
    expect(pageHasLayout()).toBe(true);
  });
});

describe("hasRenderableBox", () => {
  it("requires BOTH dimensions - a zero-width or zero-height box is not renderable", () => {
    expect(hasRenderableBox(box(document.createElement("div"), 10, 10))).toBe(true);
    expect(hasRenderableBox(box(document.createElement("div"), 0, 10))).toBe(false);
    expect(hasRenderableBox(box(document.createElement("div"), 10, 0))).toBe(false);
  });
});

describe("isStructuralRoot", () => {
  it("stops the upward walk at body, <html> and <main>", () => {
    expect(isStructuralRoot(document.body)).toBe(true);
    expect(isStructuralRoot(document.documentElement)).toBe(true);
    expect(isStructuralRoot(document.createElement("main"))).toBe(true);
  });

  it("does not stop at an ordinary container", () => {
    expect(isStructuralRoot(document.createElement("div"))).toBe(false);
    expect(isStructuralRoot(document.createElement("article"))).toBe(false);
  });
});

describe("isRenderableInPageLayout", () => {
  it("accepts anything while the page reports no layout at all", () => {
    const el = box(document.createElement("div"), 0, 0);
    document.body.append(el);
    expect(isRenderableInPageLayout(el)).toBe(true);
  });

  it("accepts a visible element with a box", () => {
    layoutPage();
    const el = box(document.createElement("div"), 20, 20);
    document.body.append(el);
    expect(isRenderableInPageLayout(el)).toBe(true);
  });

  it("rejects a zero-box element that we did not hide ourselves", () => {
    layoutPage();
    const el = box(document.createElement("div"), 0, 0);
    document.body.append(el);
    expect(isRenderableInPageLayout(el)).toBe(false);
  });

  it("rejects a boxed element hidden by an ANCESTOR's display:none", () => {
    layoutPage();
    const parent = document.createElement("div");
    parent.style.display = "none";
    const el = box(document.createElement("div"), 20, 20);
    parent.append(el);
    document.body.append(parent);
    expect(isRenderableInPageLayout(el)).toBe(false);
  });

  it("rejects a boxed element under visibility:hidden and under opacity:0", () => {
    layoutPage();
    for (const [prop, value] of [
      ["visibility", "hidden"],
      ["opacity", "0"],
    ] as const) {
      const parent = document.createElement("div");
      parent.style[prop] = value;
      const el = box(document.createElement("div"), 20, 20);
      parent.append(el);
      document.body.append(parent);
      expect(isRenderableInPageLayout(el), `${prop}: ${value}`).toBe(false);
    }
  });

  // The "Hide original buttons" exemption: a control we collapsed stays
  // anchor-eligible, and the marker sits on an ANCESTOR of the inner control
  // the scan walks - so a self-only check would miss it.
  it("accepts a zero-box control whose ancestor carries our hidden marker", () => {
    layoutPage();
    const hiddenSlot = document.createElement("div");
    hiddenSlot.setAttribute("data-khasky-emojery-hidden", "1");
    const control = box(document.createElement("button"), 0, 0);
    hiddenSlot.append(control);
    document.body.append(hiddenSlot);
    expect(isRenderableInPageLayout(control)).toBe(true);
  });
});

describe("findVisualActionSlot", () => {
  it("returns null while the page reports no layout (caller falls back to structure)", () => {
    const { buttons } = buildRow({ widths: [40, 40, 40] });
    expect(findVisualActionSlot(buttons[1]!)).toBeNull();
  });

  it("resolves the control's own slot and reports its index within the row", () => {
    layoutPage();
    const { row, buttons } = buildRow({ widths: [40, 40, 40] });
    const found = findVisualActionSlot(buttons[1]!);
    expect(found?.row).toBe(row);
    expect(found?.index).toBe(1);
    expect(found?.slots).toHaveLength(3);
    expect(found?.slot).toBe(buttons[1]!.parentElement);
  });

  it("climbs to the row when the control sits deeper than its slot", () => {
    layoutPage();
    const { row, buttons } = buildRow({ widths: [40, 40, 40] });
    const inner = box(document.createElement("button"), 40, 32);
    buttons[0]!.append(inner);
    expect(findVisualActionSlot(inner)?.row).toBe(row);
  });

  it("returns null for a control the caller already collapsed to nothing", () => {
    layoutPage();
    const { buttons } = buildRow({ widths: [40, 40, 40] });
    box(buttons[1]!, 0, 0);
    expect(findVisualActionSlot(buttons[1]!)).toBeNull();
  });

  describe("row-shape filters", () => {
    it("rejects a row with fewer slots than minSlots (default 2)", () => {
      layoutPage();
      const { buttons } = buildRow({ widths: [40] });
      expect(findVisualActionSlot(buttons[0]!)).toBeNull();
    });

    it("rejects a row with more slots than maxSlots", () => {
      layoutPage();
      const { buttons } = buildRow({ widths: [40, 40, 40, 40] });
      expect(findVisualActionSlot(buttons[0]!, { maxSlots: 3 })).toBeNull();
      expect(findVisualActionSlot(buttons[0]!, { maxSlots: 4 })).not.toBeNull();
    });

    it("rejects a row narrower than minRowWidth", () => {
      layoutPage();
      const { buttons } = buildRow({ widths: [40, 40, 40], rowWidth: 200 });
      expect(findVisualActionSlot(buttons[0]!, { minRowWidth: 300 })).toBeNull();
      expect(findVisualActionSlot(buttons[0]!, { minRowWidth: 200 })).not.toBeNull();
    });

    it("rejects a row taller than maxRowHeight - a tall block is a card, not an action row", () => {
      layoutPage();
      const { buttons } = buildRow({ widths: [40, 40, 40], rowHeight: 120 });
      expect(findVisualActionSlot(buttons[0]!, { maxRowHeight: 100 })).toBeNull();
      expect(findVisualActionSlot(buttons[0]!, { maxRowHeight: 120 })).not.toBeNull();
    });

    it("drops slots under minSlotWidth / minSlotHeight, which can starve the row below minSlots", () => {
      layoutPage();
      const { buttons } = buildRow({ widths: [40, 40, 4] });
      // The 4px slot is filtered out, leaving 2 - still a row.
      expect(findVisualActionSlot(buttons[0]!, { minSlotWidth: 10 })?.slots).toHaveLength(2);
      // Raising the floor starves it below minSlots.
      expect(findVisualActionSlot(buttons[0]!, { minSlotWidth: 60 })).toBeNull();
      expect(findVisualActionSlot(buttons[0]!, { minSlotHeight: 40 })).toBeNull();
    });
  });

  describe("width variance", () => {
    // (widest - narrowest) / widest, compared with `>` - so a row sitting
    // EXACTLY on the threshold is still an action row.
    it("accepts a row exactly at the variance threshold and rejects the one past it", () => {
      layoutPage();
      const even = buildRow({ widths: [100, 100, 50] });
      expect(findVisualActionSlot(even.buttons[0]!, { maxWidthVariance: 0.5 })).not.toBeNull();
      expect(findVisualActionSlot(even.buttons[0]!, { maxWidthVariance: 0.49 })).toBeNull();
    });

    it("ignores the variance filter when it is not configured", () => {
      layoutPage();
      const { buttons } = buildRow({ widths: [400, 20, 20] });
      expect(findVisualActionSlot(buttons[0]!)).not.toBeNull();
    });
  });

  describe("walk limits", () => {
    it("stops at a caller-declared boundary instead of climbing into it", () => {
      layoutPage();
      const { row, buttons } = buildRow({ widths: [40, 40, 40] });
      expect(findVisualActionSlot(buttons[0]!, { boundary: (el) => el === row })).toBeNull();
    });

    it("gives up after maxDepth ancestors", () => {
      layoutPage();
      const { buttons } = buildRow({ widths: [40, 40, 40] });
      let node = buttons[0]!;
      for (let i = 0; i < 3; i += 1) {
        const wrapper = box(document.createElement("div"), 40, 32);
        node.append(wrapper);
        node = wrapper;
      }
      const deep = box(document.createElement("button"), 40, 32);
      node.append(deep);
      expect(findVisualActionSlot(deep, { maxDepth: 1 })).toBeNull();
      expect(findVisualActionSlot(deep, { maxDepth: 8 })).not.toBeNull();
    });
  });

  describe("own nodes and hidden placeholders", () => {
    it("never counts a slot holding our own injected host as a row slot", () => {
      layoutPage();
      const { row, buttons } = buildRow({ widths: [40, 40, 40] });
      const ourSlot = box(document.createElement("div"), 40, 32);
      const ourHost = box(document.createElement("button"), 40, 32);
      ourHost.classList.add(HOST_CLASS);
      ourSlot.append(ourHost);
      row.append(ourSlot);
      expect(findVisualActionSlot(buttons[0]!)?.slots).toHaveLength(3);
    });

    // The regression this placeholder exists for: hiding the native control
    // must NOT renumber the row, or a visible sibling slides into slot 0 and
    // the picker re-anchors past the control it replaced.
    it("keeps a hidden control's slot at its original index instead of renumbering the row", () => {
      layoutPage();
      const { row, buttons } = buildRow({ widths: [40, 40, 40] });
      const firstSlot = row.children[0] as HTMLElement;
      firstSlot.setAttribute("data-khasky-emojery-hidden", "1");
      box(buttons[0]!, 0, 0);

      const found = findVisualActionSlot(buttons[2]!);
      expect(found?.slots).toHaveLength(3);
      expect(found?.index).toBe(2);
      expect(found?.slots[0]).toBe(firstSlot);
    });

    it("exempts the hidden placeholder from the size and variance filters", () => {
      layoutPage();
      const { row, buttons } = buildRow({ widths: [40, 40, 40] });
      const firstSlot = row.children[0] as HTMLElement;
      firstSlot.setAttribute("data-khasky-emojery-hidden", "1");
      box(buttons[0]!, 0, 0);
      // Its 0px width would blow any variance budget if it were measured.
      expect(findVisualActionSlot(buttons[2]!, { minSlotWidth: 10, maxWidthVariance: 0.01 })?.slots).toHaveLength(3);
    });
  });

  describe("control identification", () => {
    it("treats only elements matching controlSelector as slots", () => {
      layoutPage();
      const row = box(document.createElement("div"), 500, 40);
      const spans: HTMLElement[] = [];
      for (let i = 0; i < 3; i += 1) {
        const slot = box(document.createElement("div"), 40, 32);
        const span = box(document.createElement("span"), 40, 32);
        slot.append(span);
        row.append(slot);
        spans.push(span);
      }
      document.body.append(row);
      expect(findVisualActionSlot(spans[0]!)).toBeNull();
      expect(findVisualActionSlot(spans[0]!, { controlSelector: "span" })?.index).toBe(0);
    });

    it("honours a controlPredicate override", () => {
      layoutPage();
      const { buttons } = buildRow({ widths: [40, 40, 40] });
      expect(findVisualActionSlot(buttons[0]!, { controlPredicate: () => false })).toBeNull();
    });
  });
});
