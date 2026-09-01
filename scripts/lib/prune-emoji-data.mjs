// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pruning logic for emojibase compact.json, used by scripts/copy-emoji-locales.mjs to write
// public/emoji-data/<locale>.json - every locale, English included, since all of them are
// fetched at runtime and none is bundled. Consumers read entries through `buildMap` in
// emoji-meta.ts, which only ever touches { unicode, label, tags } and the picker's REACTIONS
// set - everything else in the compact format (skins, regional indicators, ZWJ sequences,
// hexcode/group/order) is dead weight, stripped here so every locale ships the same
// minimal shape.

const VS16 = /\uFE0F/g;
/** @param {string} s */
const stripVS16 = (s) => s.replace(VS16, "");

/**
 * `skins` is dropped (no skin-tone UI); empty `label`/`tags` are omitted so the JSON
 * stays compact in locales that don't translate every tag.
 */
export function pruneCompactData(compactEntries, keep) {
  const out = [];
  for (const e of compactEntries) {
    if (!e?.unicode) continue;
    if (!keep.has(e.unicode) && !keep.has(stripVS16(e.unicode))) continue;
    const next = { unicode: e.unicode };
    if (e.label) next.label = e.label;
    if (e.tags?.length) next.tags = e.tags;
    out.push(next);
  }
  return out;
}
