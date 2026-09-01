// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generate the picker's emoji metadata from emojibase-data, pruned to the
// picker's REACTIONS entries via `scripts/lib/prune-emoji-data.mjs`, into
// public/emoji-data/<locale>.json - ALL locales fetched at runtime by
// emoji-meta.ts, English included (WXT/Vite have no code splitting in MV3
// content scripts, so a statically-imported English set lands whole in every
// one). Also emits src/shared/__generated__/messages-en.json: the i18n fallback
// dictionary stripped of translator-only `description` fields, which are pure
// weight in a bundle. scripts/check-bundle-budget.mjs is what holds both lines.

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readPaletteKeepSet } from "./lib/emoji-palette.mjs";
import { pruneCompactData } from "./lib/prune-emoji-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(__dirname, "../node_modules/emojibase-data");
const PUBLIC_DEST = resolve(__dirname, "../public/emoji-data");
const BUNDLE_DEST = resolve(__dirname, "../src/shared/__generated__");
const MESSAGES_SRC = resolve(__dirname, "../public/_locales/en/messages.json");
const MESSAGES_SLIM = resolve(BUNDLE_DEST, "messages-en.json");
const PUBLIC_EMOJI_LOCALES = new Set(["bn", "da", "de", "en", "es", "et", "fi", "fr", "hi", "hu", "it", "ja", "ko", "lt", "ms", "nb", "nl", "pl", "pt", "ru", "sv", "th", "uk", "vi", "zh", "zh-hant"]);

if (!existsSync(SRC)) {
  console.warn("[copy-emoji-locales] emojibase-data not installed; skipping");
  process.exit(0);
}

const keep = readPaletteKeepSet();
if (keep.size === 0) {
  console.error("[copy-emoji-locales] the emoji palette is empty - refusing to ship empty locale files");
  process.exit(1);
}

mkdirSync(PUBLIC_DEST, { recursive: true });
mkdirSync(BUNDLE_DEST, { recursive: true });

const locales = readdirSync(SRC, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .filter((name) => PUBLIC_EMOJI_LOCALES.has(name) && existsSync(resolve(SRC, name, "compact.json")));

for (const entry of readdirSync(PUBLIC_DEST, { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
  const locale = entry.name.slice(0, -".json".length);
  if (!PUBLIC_EMOJI_LOCALES.has(locale)) {
    unlinkSync(resolve(PUBLIC_DEST, entry.name));
  }
}

let beforeTotal = 0;
let afterTotal = 0;
let enWritten = false;

for (const locale of locales) {
  const srcPath = resolve(SRC, locale, "compact.json");
  const destPath = resolve(PUBLIC_DEST, `${locale}.json`);
  const compactEntries = JSON.parse(readFileSync(srcPath, "utf8"));
  const pruned = pruneCompactData(compactEntries, keep);
  const json = JSON.stringify(pruned);
  // Both serialised minified, so "before" matches what shipping the raw array would weigh.
  beforeTotal += Buffer.byteLength(JSON.stringify(compactEntries));
  afterTotal += Buffer.byteLength(json);
  writeFileSync(destPath, json);
  if (locale === "en") enWritten = true;
}

if (!enWritten) {
  console.error("[copy-emoji-locales] emojibase-data has no `en` locale - the universal fallback would be missing");
  process.exit(1);
}

// The bundled i18n fallback: `message` (and `placeholders`, when present) only.
// The `description` fields are instructions for translators and never render.
const messages = JSON.parse(readFileSync(MESSAGES_SRC, "utf8"));
const slim = Object.fromEntries(Object.entries(messages).map(([key, entry]) => [key, { message: entry.message, ...(entry.placeholders ? { placeholders: entry.placeholders } : {}) }]));
writeFileSync(MESSAGES_SLIM, `${JSON.stringify(slim, null, 1)}\n`);

const pct = beforeTotal > 0 ? `${(100 - (afterTotal / beforeTotal) * 100).toFixed(0)}% smaller` : "n/a";
console.log(`[copy-emoji-locales] pruned ${locales.length} locales -> public/emoji-data/ (${(beforeTotal / 1024).toFixed(0)} kB -> ${(afterTotal / 1024).toFixed(0)} kB, ${pct}) + src/shared/__generated__/messages-en.json`);
