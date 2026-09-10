// SPDX-License-Identifier: GPL-3.0-or-later
//
// The shipped bundles do not carry the picker stylesheet as authored: wxt.config.ts runs it
// through scripts/lib/shrink-raw-css.ts at build time, because the sheet travels as a STRING
// (the picker mounts into a shadow root) and is inlined into every site content script,
// where its rationale comments measured ~24 kB per bundle.
//
// That transform is only allowed to remove bytes a parser discards, so a REAL engine
// decides: both forms are parsed and the resulting rules compared. A unit test cannot do
// this - jsdom's CSS parser drops what it does not understand, which is exactly the
// difference under test. vitest.browser.config.ts runs the same plugin as the build, so the
// plain `?raw` import below IS the shipped text; the `&authored` query is what the plugin
// leaves alone.

import { describe, expect, it } from "vitest";
import shipped from "./picker.css?raw";
import authored from "./picker.css?raw&authored";

function rulesOf(css: string): string[] {
  const el = document.createElement("style");
  el.textContent = css;
  document.head.appendChild(el);
  try {
    // Whitespace around a comma is never significant in CSS, but an engine serializes a
    // `var()`-carrying value from its original tokens, so `max(a, b)` and `max(a,b)` come
    // back as they were written; folding both onto the comma is what lets the rule
    // comparison see the value and not the printer.
    return Array.from(el.sheet?.cssRules ?? []).map((rule) =>
      rule.cssText
        .replace(/\s+/g, " ")
        .replace(/\s*,\s*/g, ",")
        .trim(),
    );
  } finally {
    el.remove();
  }
}

describe("the built picker stylesheet", () => {
  it("produces the same rules, in the same order, as the authored source", () => {
    const authoredRules = rulesOf(authored);
    // Non-empty first: two empty lists would compare equal and prove nothing.
    expect(authoredRules.length, "the engine parsed no rules - the comparison below would be vacuous").toBeGreaterThan(50);
    expect(rulesOf(shipped)).toEqual(authoredRules);
  });

  it("actually removes bytes, or the build-time transform is doing nothing", () => {
    expect(shipped.length).toBeLessThan(authored.length * 0.8);
  });
});
