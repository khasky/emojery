// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shrinkCss } from "./css-shrink.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("shrinkCss", () => {
  it("drops comment spans", () => {
    expect(shrinkCss("/* why */\n.a { color: red; }")).toBe(".a { color: red; }");
  });

  it("keeps a comment-looking sequence inside a string", () => {
    // `content` is real output; eating it would change what the page renders.
    expect(shrinkCss('.a::after { content: "/* not a comment */"; }')).toBe('.a::after { content: "/* not a comment */"; }');
  });

  it("keeps an escaped quote from ending the string early", () => {
    expect(shrinkCss('.a::after { content: "he said \\" /* x */"; }')).toBe('.a::after { content: "he said \\" /* x */"; }');
  });

  it("leaves an unquoted url() token untouched", () => {
    expect(shrinkCss(".a { background: url(data:image/svg+xml;base64,AAA/*BBB); }")).toBe(".a { background: url(data:image/svg+xml;base64,AAA/*BBB); }");
  });

  it("drops indentation and blank lines but keeps declarations on their own lines", () => {
    expect(shrinkCss(".a {\n\n    color: red;\n\n    top: 0;\n}\n")).toBe(".a {\ncolor: red;\ntop: 0;\n}");
  });

  it("survives an unterminated comment instead of emitting half a rule", () => {
    expect(shrinkCss(".a { color: red; }\n/* unterminated")).toBe(".a { color: red; }");
  });

  it("preserves every selector, property and value of the real picker stylesheet", () => {
    // The guarantee that matters: the transform removes bytes, never content. Tokens are
    // compared as a multiset, so a dropped declaration or a mangled value fails here
    // (the browser-side CSSOM equivalence check lives in src/ui/picker-css.browser.test.tsx).
    const css = readFileSync(resolve(repoRoot, "src/ui/picker.css"), "utf8");
    const tokens = (text) =>
      text
        .replace(/\/\*[\s\S]*?\*\//g, " ")
        .split(/[\s;{}]+/)
        .filter(Boolean)
        .sort();

    const shrunk = shrinkCss(css);
    expect(tokens(shrunk)).toEqual(tokens(css));
    expect(shrunk.length).toBeLessThan(css.length * 0.75);
  });
});
