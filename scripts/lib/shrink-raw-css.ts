// SPDX-License-Identifier: GPL-3.0-or-later
//
// The picker stylesheet ships as a STRING (`import css from "./picker.css?raw"` - it mounts
// into a shadow root), inlined into every content-script bundle together with the rationale
// comments the source is written with. This Vite plugin hands the `?raw` loader the
// whitespace-minified text instead: esbuild parses the sheet and prints it back without
// comments and layout whitespace, and `minifySyntax` stays off so no declaration is
// rewritten. src/ui/picker-css.browser.test.tsx compares the two forms rule by rule in real
// engines; scripts/check-bundle-budget.mjs holds the byte ceiling the saving serves.

import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";

export function shrinkCss(css: string, sourcefile?: string): string {
  const { code, warnings } = transformSync(css, { loader: "css", minifyWhitespace: true, ...(sourcefile ? { sourcefile } : {}) });
  if (warnings.length > 0) throw new Error(`shrinkCss: esbuild warned:\n${warnings.map((w) => `${w.location?.file ?? ""}:${w.location?.line ?? 0} ${w.text}`).join("\n")}`);
  return code;
}

export function shrinkRawCssPlugin() {
  return {
    name: "emojery:shrink-raw-css",
    // Ahead of Vite's own `?raw` loader, so this owns the module's contents.
    enforce: "pre" as const,
    load(id: string) {
      if (!id.endsWith(".css?raw")) return null;
      const file = id.slice(0, -"?raw".length);
      return `export default ${JSON.stringify(shrinkCss(readFileSync(file, "utf8"), file))};`;
    },
  };
}
