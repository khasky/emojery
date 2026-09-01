// SPDX-License-Identifier: GPL-3.0-or-later
// Placement strategies over GENERIC sentinel elements (no fake supported-site
// DOM): priority order, accept-validation/transform, slot resolution, and the
// no-match cases. The real per-site placement is verified by e2e.
import { describe, expect, it } from "vitest";
import { findFirstAnchor, findSiblingAction, slotAction } from "./placement";

function el(cls: string): HTMLElement {
  const node = document.createElement("div");
  node.className = cls;
  document.body.appendChild(node);
  return node;
}

describe("findFirstAnchor", () => {
  it("returns the first candidate's match in priority order", () => {
    const a = el("alpha");
    el("beta");
    expect(findFirstAnchor(document, [{ selectors: [".missing"] }, { selectors: [".alpha"] }, { selectors: [".beta"] }])).toBe(a);
  });

  it("skips a candidate whose accept rejects, trying the next", () => {
    el("alpha");
    const b = el("beta");
    expect(findFirstAnchor(document, [{ selectors: [".alpha"], accept: () => null }, { selectors: [".beta"] }])).toBe(b);
  });

  it("accept can transform a match into a different anchor", () => {
    const parent = el("wrap");
    const child = document.createElement("span");
    parent.appendChild(child);
    expect(findFirstAnchor(document, [{ selectors: [".wrap"], accept: (m) => m.querySelector<HTMLElement>("span") }])).toBe(child);
  });

  it("iterates all matches of a selector, returning the first accept-passing one", () => {
    el("row");
    const second = el("row");
    second.setAttribute("data-ok", "1");
    expect(findFirstAnchor(document, [{ selectors: [".row"], accept: (m) => (m.hasAttribute("data-ok") ? m : null) }])).toBe(second);
  });

  it("returns null when nothing matches", () => {
    expect(findFirstAnchor(document, [{ selectors: [".nope"] }])).toBeNull();
  });
});

describe("findSiblingAction / slotAction", () => {
  it("returns the first action found, resolved to its anchor, in priority order", () => {
    const scope = document.createElement("div");
    const action = document.createElement("button");
    action.className = "act-b";
    scope.appendChild(action);
    document.body.appendChild(scope);

    const wrap = document.createElement("div");
    expect(
      findSiblingAction(scope, [
        { selectors: [".act-a"], resolve: (m) => m },
        { selectors: [".act-b"], resolve: () => wrap },
      ]),
    ).toBe(wrap);
  });

  it("a resolve returning null rejects the candidate; nothing found gives null", () => {
    const scope = document.createElement("div");
    const action = document.createElement("button");
    action.className = "act-a";
    scope.appendChild(action);
    document.body.appendChild(scope);

    expect(findSiblingAction(scope, [{ selectors: [".act-a"], resolve: () => null }])).toBeNull();
  });

  it("slotAction resolves a nested match to the row's direct-child slot, falling back to the match", () => {
    const row = document.createElement("div");
    const slot = document.createElement("div");
    const nested = document.createElement("button");
    nested.className = "deep";
    slot.appendChild(nested);
    row.appendChild(slot);
    document.body.appendChild(row);

    const action = slotAction(row, [".deep"]);
    expect(action.resolve(nested)).toBe(slot);

    const stray = document.createElement("button");
    document.body.appendChild(stray);
    expect(action.resolve(stray)).toBe(stray);
  });
});
