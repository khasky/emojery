// SPDX-License-Identifier: GPL-3.0-or-later
//
// The shipped sheet against the geometry the picker crops with. Nothing at
// runtime notices a mismatch: emoji-sprite.ts probes the sheet with an Image and
// silently keeps OS-font glyphs when it fails to load, so a renamed, missing or
// re-sized sheet ships as "the emoji look different on some machines" rather
// than as an error. The byte budget is the other half - the sheet is fetched
// into the renderer of every page that mounts a trigger, and it grew to 3.7 MB
// once already.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SPRITE_CELL, SPRITE_COLS, SPRITE_FILE, SPRITE_ROWS } from "./__generated__/emoji-sprite-map";

const PUBLIC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../public");

// Headroom over the current sheet for a Noto refresh or a few added emoji;
// anything that doubles it (a return to PNG, a bigger cell) trips this.
const SHEET_MAX_BYTES = 1_400_000;

// Canvas size of an extended-format WebP (RIFF/WEBP + VP8X): the two 24-bit
// little-endian `-1` fields the container header carries. Written by every
// encoder that emits alpha, which this sheet needs.
function webpCanvasSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 4).toString("ascii"), "sheet must be a RIFF container").toBe("RIFF");
  expect(bytes.subarray(8, 12).toString("ascii"), "sheet must be WEBP").toBe("WEBP");
  expect(bytes.subarray(12, 16).toString("ascii"), "sheet must carry the extended VP8X header").toBe("VP8X");
  return {
    width: bytes.readUIntLE(24, 3) + 1,
    height: bytes.readUIntLE(27, 3) + 1,
  };
}

describe("shipped emoji sheet", () => {
  const bytes = readFileSync(resolve(PUBLIC_DIR, SPRITE_FILE));

  it("is laid out exactly as the generated map says", () => {
    const { width, height } = webpCanvasSize(bytes);
    expect(width).toBe(SPRITE_COLS * SPRITE_CELL);
    expect(height).toBe(SPRITE_ROWS * SPRITE_CELL);
  });

  it("stays inside its byte budget", () => {
    expect(bytes.length, `${SPRITE_FILE} is ${(bytes.length / 1024).toFixed(0)} kB`).toBeLessThan(SHEET_MAX_BYTES);
  });
});
