// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drop comments and layout whitespace from a stylesheet that ships as a STRING.
//
// `src/ui/picker.css` and `animations.css` are imported with `?raw` (the picker mounts into
// a shadow root, so its CSS travels as text, not as a linked sheet). That text is inlined
// into every content-script bundle, once per bundle, and it carries the full rationale
// comments the source is written with - a large share of picker.css by weight. The bundles
// run against the byte ceiling in scripts/check-bundle-budget.mjs, which is what decides
// whether the saving still matters; `pnpm check:bundle` prints the current sizes.
//
// Deliberately NOT a CSS minifier. It never reorders, merges, shortens or re-serializes a
// declaration - it only removes bytes no parser keeps: comment spans, trailing whitespace,
// blank lines and leading indentation. That is what makes it safe to apply to a stylesheet
// nobody re-reads afterwards, and it is why the transform is a string operation rather than
// a parse-and-print. `css-shrink.test.mjs` pins the string- and url()-awareness.

/**
 * Remove `/* ... *\/` comment spans, leaving comment-looking text inside strings and
 * `url()` tokens alone.
 * @param {string} css
 * @returns {string}
 */
function stripComments(css) {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const ch = css[i];

    // A quoted string: copy verbatim, honouring backslash escapes.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < css.length) {
        if (css[i] === "\\") {
          out += css[i] + (css[i + 1] ?? "");
          i += 2;
          continue;
        }
        out += css[i];
        const done = css[i] === quote;
        i += 1;
        if (done) break;
      }
      continue;
    }

    // An unquoted url(...) token: its contents are not string-quoted but are still data.
    if (ch === "u" && css.startsWith("url(", i)) {
      const end = css.indexOf(")", i);
      const stop = end === -1 ? css.length : end + 1;
      out += css.slice(i, stop);
      i = stop;
      continue;
    }

    if (ch === "/" && css[i + 1] === "*") {
      const end = css.indexOf("*/", i + 2);
      i = end === -1 ? css.length : end + 2;
      continue;
    }

    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Comment-free, indentation-free stylesheet text. Line-based, which is safe because CSS
 * strings cannot contain a raw newline - so no trim can ever reach inside one.
 * @param {string} css
 * @returns {string}
 */
export function shrinkCss(css) {
  return stripComments(css)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join("\n");
}
