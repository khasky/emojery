// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every custom property a page stylesheet READS has to be defined somewhere
// that sheet can see - its own rules or the tokens it imports. An undefined
// `var()` is not a CSS error: the declaration is simply dropped, so the element
// paints with nothing at all. That is how the onboarding page shipped an unpainted
// progress fill and an unpainted primary button (both read a `-fixed-primary`
// that only popup.css declared).
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..");

// The extension's own pages. The in-page picker is deliberately absent: it
// renders in a shadow root inside a foreign page and carries its whole palette
// on `:host` (ui/picker.css), importing nothing.
const PAGE_SHEETS = ["entrypoints/popup/popup.css", "entrypoints/auth/auth.css", "entrypoints/onboarding/onboarding.css"];

const read = (rel: string): string => readFileSync(resolve(SRC, rel), "utf8");

// `@import "../../styles/tokens.css";` - resolved relative to the sheet, so a
// renamed or moved tokens file fails loudly here rather than at paint time.
function withImports(rel: string): string {
  const css = read(rel);
  const imports = [...css.matchAll(/@import\s+["']([^"']+)["']/g)].map((m) => resolve(dirname(resolve(SRC, rel)), m[1] ?? ""));
  return imports.map((file) => readFileSync(file, "utf8")).join("\n") + css;
}

// Stamped per element at runtime by ui/emoji-sprite.ts (the sprite cell and the
// sheet's dimensions), so no stylesheet declares them and none should.
const RUNTIME_STAMPED = new Set(["--khasky-emojery-col", "--khasky-emojery-row", "--khasky-emojery-sprite-cols", "--khasky-emojery-sprite-rows"]);

const declared = (css: string): Set<string> => new Set([...css.matchAll(/(--khasky-emojery-[\w-]+)\s*:/g)].map((m) => m[1] as string));

// Only bare reads: `var(--x, fallback)` paints the fallback, so it cannot go blank.
const readWithoutFallback = (css: string): string[] => [...css.matchAll(/var\(\s*(--khasky-emojery-[\w-]+)\s*\)/g)].map((m) => m[1] as string);

describe("page stylesheets", () => {
  for (const sheet of PAGE_SHEETS) {
    it(`${sheet} reads no custom property it cannot see`, () => {
      const css = withImports(sheet);
      const defined = declared(css);
      const missing = [...new Set(readWithoutFallback(css))].filter((name) => !defined.has(name) && !RUNTIME_STAMPED.has(name));

      expect(missing, `${sheet} paints nothing where these resolve: ${missing.join(", ")}`).toEqual([]);
    });
  }

  // The pair the bug was about: shared, so it belongs to the tokens file rather
  // than to whichever page happened to need it first.
  it("declares the fixed primary blues in the shared tokens", () => {
    const tokens = declared(read("styles/tokens.css"));

    expect(tokens.has("--khasky-emojery-fixed-primary")).toBe(true);
    expect(tokens.has("--khasky-emojery-fixed-primary-hover")).toBe(true);
  });
});
