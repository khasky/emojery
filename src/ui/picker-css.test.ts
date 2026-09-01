// SPDX-License-Identifier: GPL-3.0-or-later
//
// Invariants of the shipped picker stylesheet that no rendered assertion catches:
// the engine lays the popover out either way, and the damage surfaces as a wrong
// scroll height only in a browser that applies the property.
import { describe, expect, it } from "vitest";
import { PICKER_STYLESHEET } from "./mount-shadow";

// Declarations only: the comments in these rules name the very properties being
// asserted on, so leaving them in would let prose satisfy the check.
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Selector comes from the test body, never from input, and is escaped above.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const match = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(PICKER_STYLESHEET);
  expect(match, `no rule found for ${selector}`).not.toBeNull();
  return (match?.[1] ?? "").replace(/\/\*[\s\S]*?\*\//g, "");
}

describe("emoji grid cell", () => {
  // Why the cells carry `content-visibility: auto` lives on .khasky-emojery-grid-item in
  // picker.css. What this pins: under the resulting SIZE containment only `aspect-ratio`
  // resolved against the grid track's width can still size a skipped cell, so dropping either
  // half collapses every off-screen row - the scroll height, the category-bar jumps and the
  // scroll-spy with it.
  it("pairs content-visibility with a size the contained box can still resolve", () => {
    const body = ruleBody(".khasky-emojery-grid-item");
    expect(body).toContain("content-visibility");
    expect(body, "a skipped cell has no contents to size it").toMatch(/aspect-ratio|contain-intrinsic-size/);
    expect(body, "aspect-ratio needs a width to resolve against").toMatch(/width:/);
  });
});
