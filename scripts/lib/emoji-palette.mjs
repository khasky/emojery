// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Plain JSON, not a regex over source - the palette file can be reformatted freely.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PALETTE_JSON = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/shared/__data__/emoji-categories.json");

const VS16 = /️/g;
/** @param {string} s */
const stripVS16 = (s) => s.replace(VS16, "");

/**
 * Every palette emoji in source order, de-duplicated. The sprite sheet is keyed
 * by this order, so it must stay the order the JSON declares.
 * @returns {string[]}
 */
export function readPaletteEmojis() {
  /** @type {Array<{ emojis: string[] }>} */
  const categories = JSON.parse(readFileSync(PALETTE_JSON, "utf8"));
  const seen = new Set();
  const out = [];
  for (const category of categories) {
    for (const emoji of category.emojis) {
      if (seen.has(emoji)) continue;
      seen.add(emoji);
      out.push(emoji);
    }
  }
  return out;
}

/**
 * The palette as a lookup set holding BOTH the original and the VS-16-stripped
 * form of each emoji: emojibase sometimes ships the short form where the picker
 * uses the variation form, and matching either side keeps lookups symmetric with
 * `addEntry` in emoji-meta.ts at runtime.
 * @returns {Set<string>}
 */
export function readPaletteKeepSet() {
  const keep = new Set();
  for (const emoji of readPaletteEmojis()) {
    keep.add(emoji);
    keep.add(stripVS16(emoji));
  }
  return keep;
}
