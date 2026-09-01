// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generic elements only, never a supported site's markup: what is under test here
// is the PickerInsertionPoint contract - which of the two declared placements wins
// and whether a mounted host is still on it - not any site's row (CONTRIBUTING.md,
// "where a test belongs"). Real placement on a real page stays e2e's.
import { afterEach, describe, expect, it } from "vitest";
import type { PickerInsertionPoint } from "../shared/adapter";
import { HOST_CLASS, PLACEMENT_ATTR } from "../shared/dom";
import { insertionContainer, isFallbackPlacement, isRendered, placementModeChanged, resolveResponsivePlacement } from "./mount-placement";

// jsdom reports `offsetParent === null` for everything, which is exactly the
// "not rendered" reading; `position: fixed` is the branch that flips it back, so
// these two build a visible and a hidden container without stubbing layout.
function shown(): HTMLElement {
  const el = document.createElement("div");
  el.style.position = "fixed";
  document.body.appendChild(el);
  return el;
}

function hidden(): HTMLElement {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function point(overrides: Partial<PickerInsertionPoint> & Pick<PickerInsertionPoint, "anchor">): PickerInsertionPoint {
  return { position: "after", target: { site: "github", targetId: "o/r", url: "https://github.com/o/r" }, ...overrides };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("isRendered", () => {
  it("counts a detached element as not rendered", () => {
    const el = document.createElement("div");
    el.style.position = "fixed";
    expect(isRendered(el)).toBe(false);
  });

  it("counts a connected fixed-position element as rendered", () => {
    expect(isRendered(shown())).toBe(true);
  });
});

describe("insertionContainer", () => {
  it("takes the anchor itself for an append", () => {
    const anchor = shown();
    expect(insertionContainer(anchor, "append")).toBe(anchor);
  });

  it("takes the anchor's parent for a sibling insert", () => {
    const parent = shown();
    const anchor = document.createElement("div");
    parent.appendChild(anchor);
    expect(insertionContainer(anchor, "before")).toBe(parent);
    expect(insertionContainer(anchor, "after")).toBe(parent);
  });

  it("has no container for a sibling insert against a parentless anchor", () => {
    expect(insertionContainer(document.createElement("div"), "after")).toBeNull();
  });
});

describe("isFallbackPlacement", () => {
  it("is false without a declared fallback", () => {
    expect(isFallbackPlacement(point({ anchor: shown() }))).toBe(false);
  });

  it("is false while the active anchor is still the primary one", () => {
    const primary = shown();
    expect(isFallbackPlacement(point({ anchor: primary, fallback: { anchor: shown(), position: "append" } }))).toBe(false);
  });

  it("is true once the active anchor IS the fallback anchor", () => {
    const fb = shown();
    expect(isFallbackPlacement(point({ anchor: fb, fallback: { anchor: fb, position: "append" } }))).toBe(true);
  });
});

describe("resolveResponsivePlacement", () => {
  it("returns an ordinary placement untouched", () => {
    const p = point({ anchor: hidden() });
    expect(resolveResponsivePlacement(p)).toBe(p);
  });

  it("keeps the primary while its container is rendered", () => {
    const p = point({ anchor: shown(), position: "append", fallback: { anchor: shown(), position: "append" } });
    expect(resolveResponsivePlacement(p)).toBe(p);
  });

  it("swaps to the fallback when the primary container is hidden and the fallback's is not", () => {
    // A `before` fallback is judged by its anchor's PARENT, not the anchor - the
    // whole point of insertionContainer, so the anchor itself stays a bare div.
    const fb = document.createElement("div");
    shown().appendChild(fb);
    const p = point({ anchor: hidden(), position: "append", fallback: { anchor: fb, position: "before", triggerLayout: "icon-column" } });
    const resolved = resolveResponsivePlacement(p);
    expect(resolved.anchor).toBe(fb);
    expect(resolved.position).toBe("before");
    expect(resolved.triggerLayout).toBe("icon-column");
  });

  it("stays on the primary when the fallback's container is hidden too", () => {
    const p = point({ anchor: hidden(), position: "append", fallback: { anchor: hidden(), position: "append" } });
    expect(resolveResponsivePlacement(p)).toBe(p);
  });

  it("drops a primary-only wrapper and triggerLayout that the fallback does not redeclare", () => {
    const p = point({
      anchor: hidden(),
      position: "append",
      wrapper: { tagName: "li" },
      triggerLayout: "icon-column",
      fallback: { anchor: shown(), position: "append" },
    });
    const resolved = resolveResponsivePlacement(p);
    expect("wrapper" in resolved).toBe(false);
    expect("triggerLayout" in resolved).toBe(false);
  });
});

describe("placementModeChanged", () => {
  function mountedHost(mode: "primary" | "fallback"): HTMLElement {
    const host = document.createElement("div");
    host.classList.add(HOST_CLASS);
    host.setAttribute(PLACEMENT_ATTR, mode);
    return host;
  }

  it("is false for a node that carries no host", () => {
    expect(placementModeChanged(document.createElement("div"), point({ anchor: shown() }))).toBe(false);
  });

  it("is false while the mounted mode still matches the wanted one", () => {
    expect(placementModeChanged(mountedHost("primary"), point({ anchor: shown() }))).toBe(false);
  });

  it("is true when a primary mount now wants the fallback", () => {
    const fb = shown();
    expect(placementModeChanged(mountedHost("primary"), point({ anchor: fb, fallback: { anchor: fb, position: "append" } }))).toBe(true);
  });

  it("is true when a fallback mount now wants the primary", () => {
    expect(placementModeChanged(mountedHost("fallback"), point({ anchor: shown(), fallback: { anchor: shown(), position: "append" } }))).toBe(true);
  });

  it("reads the host through an adapter wrapper around it", () => {
    const wrapper = document.createElement("li");
    wrapper.appendChild(mountedHost("fallback"));
    expect(placementModeChanged(wrapper, point({ anchor: shown() }))).toBe(true);
  });
});
