// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generate a single WebP sprite sheet for every emoji the picker can show, plus a TS lookup map
// (emoji -> cell index), so the picker and the popup History tab render each reaction from a
// fixed sheet instead of the user's OS emoji font:
//   1. public/emoji-sprite/emoji-sprite.webp - SPRITE_COLS x SPRITE_ROWS cells of SPRITE_CELL px,
//      shipped as a web_accessible_resource (wxt.config.ts).
//   2. src/ui/__generated__/emoji-sprite-map.ts - geometry + the emoji -> index map read by
//      emoji-img.tsx and stamped as CSS variables by mount.ts/popup.
//
// Art source: Noto Emoji (https://github.com/googlefonts/noto-emoji), SIL Open Font License 1.1 -
// see public/licenses/noto-emoji-OFL.txt. Vector glyphs are rasterized to CELL px (no upscaling
// artifacts); EmojiImg crops cells via an <img>, which downscales noticeably sharper than a CSS
// background-image. Swap NOTO_BASE / fileCandidates for a different set.
//
// Run on demand (NOT part of prepare:assets, so a build never regenerates the sheet):
// `pnpm run gen:emoji-sprite`. Needs network access (downloads cached under scripts/.cache)
// and Playwright's Chromium to compose the sheet on a canvas - avoids a native image
// dependency.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readPaletteEmojis } from "./lib/emoji-palette.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SPRITE_DEST_DIR = resolve(__dirname, "../public/emoji-sprite");
const SPRITE_IMAGE = resolve(SPRITE_DEST_DIR, "emoji-sprite.webp");
const MAP_DEST_DIR = resolve(__dirname, "../src/ui/__generated__");
const MAP_TS = resolve(MAP_DEST_DIR, "emoji-sprite-map.ts");
const CACHE_DIR = resolve(__dirname, ".cache");

// Noto color-emoji vector glyphs, keyed as `svg/emoji_u<hex>[_<hex>...].svg` (FE0F
// dropped). Pinned to the commit v2.051 pointed at, not the tag: a tag can be moved
// upstream, a commit cannot, so a sprite rebuild is reproducible. Override with
// NOTO_REF=<tag|commit> when intentionally bumping Noto; the cache dir keys on the ref
// so a bump re-downloads cleanly.
const NOTO_REF = process.env.NOTO_REF || "8998f5dd683424a73e2314a8c1f1e359c19e8742"; // v2.051
// Straight from GitHub at the pinned commit - no CDN in the middle to serve
// different bytes for the same ref.
const NOTO_BASE = `https://raw.githubusercontent.com/googlefonts/noto-emoji/${NOTO_REF}/svg`;
const CACHE_SUBDIR = resolve(CACHE_DIR, `noto-${NOTO_REF}-svg`);

// Cell size the SVGs are rasterized to. The on-screen <img> crop is a third of this, so 72px
// still carries a comfortable HiDPI multiple, and it is what keeps the sheet's DECODED
// footprint in check: the browser holds the whole sheet as a bitmap (w*h*4 bytes) in the
// renderer of every page that mounts a trigger, and that cost scales with pixels, not with
// file size. Raising the cell costs the square of the ratio - 96px would be ~1.8x this.
const CELL = 72;
// WebP over PNG for the same pixels: it cuts the shipped sheet several-fold. Lossy at a high
// quality - these are flat vector glyphs, and the crop renders at a third of the cell size.
// emoji-sprite.ts falls back to OS-font glyphs if the sheet fails to load.
const SHEET_MIME = "image/webp";
const SHEET_QUALITY = 0.92;
// Sheet shape: a roughly square grid keeps the sheet dimensions modest so
// neither axis blows past a browser's max canvas/texture size.
const COLS = 25;

const U200D = 0x200d;
const UFE0F = 0xfe0f;

main().catch((err) => {
  console.error("[build-emoji-sprite]", err);
  process.exit(1);
});

async function main() {
  const emojis = readPaletteEmojis();
  if (emojis.length === 0) {
    console.error("[build-emoji-sprite] the emoji palette is empty");
    process.exit(1);
  }
  const rows = Math.ceil(emojis.length / COLS);
  console.log(`[build-emoji-sprite] ${emojis.length} emoji -> ${COLS}x${rows} sheet ` + `(${COLS * CELL}x${rows * CELL}px, cell ${CELL}px), Noto Emoji @${NOTO_REF}`);

  mkdirSync(CACHE_SUBDIR, { recursive: true });
  const tiles = [];
  const missing = [];
  for (const emoji of emojis) {
    const buf = await fetchTile(emoji);
    if (!buf) {
      missing.push(`${emoji} (${fileCandidates(emoji).join(" | ")})`);
      tiles.push(null);
      continue;
    }
    // Noto SVGs carry a viewBox but no width/height (undefined intrinsic size) - stamp
    // the cell size so Chromium rasterizes the vector crisply at CELL px.
    const svg = buf.toString("utf8").replace("<svg ", `<svg width="${CELL}" height="${CELL}" `);
    tiles.push(Buffer.from(svg).toString("base64"));
  }
  if (missing.length) {
    console.error(`[build-emoji-sprite] ${missing.length} emoji missing from Noto @${NOTO_REF}:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }

  const sheet = await composeSheet(tiles, COLS, rows, CELL);
  mkdirSync(SPRITE_DEST_DIR, { recursive: true });
  writeFileSync(SPRITE_IMAGE, sheet);

  writeMap(emojis, COLS, rows);

  console.log(`[build-emoji-sprite] wrote ${rel(SPRITE_IMAGE)} ` + `(${(sheet.length / 1024).toFixed(0)} kB) and ${rel(MAP_TS)}`);
}

// Noto names files `emoji_u<cps>.svg` (code points joined by `_`) and drops the VS-16
// (U+FE0F) selector - try the stripped form first, then the fully-qualified one for the
// rare glyph that keeps it. (Our set has no ZWJ sequences, but the rule is kept.)
function fileCandidates(emoji) {
  const cps = Array.from(emoji, (ch) => ch.codePointAt(0));
  // Noto zero-pads each code point to a minimum of 4 hex digits
  // (e.g. © U+00A9 -> emoji_u00a9.svg), leaving longer ones as-is.
  const name = (list) => `emoji_u${list.map((cp) => cp.toString(16).padStart(4, "0")).join("_")}.svg`;
  const stripped = cps.filter((cp) => cp !== UFE0F);
  const candidates = [name(stripped)];
  if (stripped.length !== cps.length || cps.includes(U200D)) {
    candidates.push(name(cps));
  }
  return candidates;
}

async function fetchTile(emoji) {
  for (const file of fileCandidates(emoji)) {
    const cached = resolve(CACHE_SUBDIR, file);
    if (existsSync(cached)) return readFileSync(cached);
    const res = await fetch(`${NOTO_BASE}/${file}`);
    if (res.status === 404 || res.status === 403) continue;
    if (!res.ok) throw new Error(`fetch ${file} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(cached, buf);
    return buf;
  }
  return null;
}

// Draw every tile onto one canvas in Chromium (already installed for e2e) and read it
// back as encoded bytes - the browser's canvas avoids a native image dependency.
async function composeSheet(tilesBase64, cols, rows, cell) {
  // @playwright/test re-exports the browser launchers and is a direct dev dependency;
  // the bare `playwright` package may not be hoisted to a resolvable spot under pnpm.
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const dataUrl = await page.evaluate(
      async ({ tiles, cols, rows, cell, mime, quality }) => {
        const canvas = document.createElement("canvas");
        canvas.width = cols * cell;
        canvas.height = rows * cell;
        const ctx = canvas.getContext("2d");
        if (!ctx) throw new Error("2d canvas context unavailable");
        for (let i = 0; i < tiles.length; i++) {
          const b64 = tiles[i];
          if (!b64) continue;
          const img = new Image();
          img.src = `data:image/svg+xml;base64,${b64}`;
          await img.decode();
          const col = i % cols;
          const row = (i - col) / cols;
          ctx.drawImage(img, col * cell, row * cell, cell, cell);
        }
        return canvas.toDataURL(mime, quality);
      },
      { tiles: tilesBase64, cols, rows, cell, mime: SHEET_MIME, quality: SHEET_QUALITY },
    );
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return Buffer.from(base64, "base64");
  } finally {
    await browser.close();
  }
}

function writeMap(emojis, cols, rows) {
  mkdirSync(MAP_DEST_DIR, { recursive: true });
  const ts = `// SPDX-License-Identifier: GPL-3.0-or-later
// AUTO-GENERATED by scripts/build-emoji-sprite.mjs - do not edit by hand.
//
// Geometry for public/emoji-sprite/emoji-sprite.webp.
// Art: Noto Emoji (https://github.com/googlefonts/noto-emoji), SIL OFL 1.1.
// Regenerate with: pnpm run gen:emoji-sprite
//
// Deliberately NO emoji -> index table. This script lays the sheet out in palette order,
// reading the same __data__/emoji-categories.json the runtime reads, so an emoji's cell
// index IS its position in REACTIONS. Emitting the map would put a second copy of every
// palette emoji string into every content-script bundle, against the ceiling
// scripts/check-bundle-budget.mjs holds. ui/emoji-sprite.ts derives the index instead; the
// signature below is what makes that derivation safe to trust.

export const SPRITE_COLS = ${cols};
export const SPRITE_ROWS = ${rows};
export const SPRITE_CELL = ${CELL};
export const SPRITE_FILE = "emoji-sprite/emoji-sprite.webp";

// The palette this sheet was rasterized from: how many cells it holds, and an
// order-sensitive checksum of the emoji in cell order. emoji-sprite-coverage.test.ts
// recomputes both from the live palette, so a sheet built against a different - or merely
// reordered - palette fails the suite instead of silently rendering the wrong glyph for
// every emoji after the first change.
export const SPRITE_PALETTE_SIZE = ${emojis.length};
export const SPRITE_PALETTE_SIGNATURE = "${paletteSignature(emojis)}";
`;
  writeFileSync(MAP_TS, ts);
}

/** Order-sensitive FNV-1a over the palette, hex. Mirrored by paletteSignature in ui/emoji-sprite-coverage.test.ts, single-space separator included. */
function paletteSignature(emojis) {
  let hash = 0x811c9dc5;
  for (const unit of emojis.join(" ")) {
    hash ^= unit.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function rel(p) {
  return p.replace(resolve(__dirname, ".."), ".").replace(/\\/g, "/");
}
