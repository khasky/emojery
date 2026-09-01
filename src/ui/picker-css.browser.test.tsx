// SPDX-License-Identifier: GPL-3.0-or-later
//
// The shipped bundles do not carry the picker stylesheet as authored: wxt.config.ts runs it
// through scripts/lib/css-shrink.mjs at build time, because the sheet travels as a STRING
// (the picker mounts into a shadow root) and is inlined into every site content script,
// where its rationale comments measured ~24 kB per bundle.
//
// That transform is only allowed to remove bytes a parser discards, so a REAL engine
// decides: both forms are parsed and the resulting rules compared. A unit test cannot do
// this - jsdom's CSS parser drops what it does not understand, which is exactly the
// difference under test. The transform's string- and url()-awareness is pinned separately,
// in scripts/lib/css-shrink.test.mjs.

import { describe, expect, it } from "vitest";
import { shrinkCss } from "../../scripts/lib/css-shrink.mjs";
import { PICKER_STYLESHEET } from "./mount-shadow";

function rulesOf(css: string): string[] {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
  try {
    return Array.from(el.sheet?.cssRules ?? []).map((rule) => rule.cssText.replace(/\s+/g, " ").trim());
  } finally {
    el.remove();
  }
}

describe("the built picker stylesheet", () => {
  it("produces the same rules, in the same order, as the authored source", () => {
    const authored = rulesOf(PICKER_STYLESHEET);
    const shipped = rulesOf(shrinkCss(PICKER_STYLESHEET));
    // Non-empty first: two empty lists would compare equal and prove nothing.
    expect(authored.length, "the engine parsed no rules - the comparison below would be vacuous").toBeGreaterThan(50);
    expect(shipped).toEqual(authored);
  });

  it("actually removes bytes, or the build-time transform is doing nothing", () => {
    expect(shrinkCss(PICKER_STYLESHEET).length).toBeLessThan(PICKER_STYLESHEET.length * 0.8);
  });
});
