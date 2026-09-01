// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drift guard between the palette (shared/__data__/emoji-categories.json) and the generated
// sprite sheet (__generated__/emoji-sprite-map.ts, from `pnpm run gen:emoji-sprite`).
//
// The sheet no longer ships an emoji -> index table: it is laid out in palette order, so
// ui/emoji-sprite.ts derives the index from REACTIONS instead of carrying a second copy of
// every palette string in every content-script bundle. That derivation is only correct while the
// sheet and the palette agree on BOTH length and order, and neither is observable at
// runtime - a palette emoji added, removed or moved without regenerating would render the
// wrong glyph for every cell after it, silently. So the generator stamps a size and an
// order-sensitive checksum, and this recomputes them from the live palette.

import { describe, expect, it } from "vitest";
import { REACTIONS } from "../shared/reactions";
import { SPRITE_COLS, SPRITE_PALETTE_SIGNATURE, SPRITE_PALETTE_SIZE, SPRITE_ROWS } from "./__generated__/emoji-sprite-map";
import { emojiSpriteCell } from "./emoji-sprite";

/** Mirrors paletteSignature() in scripts/build-emoji-sprite.mjs. Order-sensitive by design. */
function paletteSignature(emojis: readonly string[]): string {
  let hash = 0x811c9dc5;
  for (const unit of emojis.join(" ")) {
    hash ^= unit.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

describe("emoji sprite sheet", () => {
  it("was rasterized from a palette of exactly this many emoji", () => {
    expect(SPRITE_PALETTE_SIZE, "palette size changed - run `pnpm run gen:emoji-sprite`").toBe(REACTIONS.length);
  });

  it("was rasterized from this palette, in this order", () => {
    // The check the derived index actually depends on: a reorder keeps the size identical
    // and shifts every cell after the moved emoji.
    expect(paletteSignature(REACTIONS), "palette contents or order changed - run `pnpm run gen:emoji-sprite`").toBe(SPRITE_PALETTE_SIGNATURE);
  });

  it("holds every palette emoji inside the declared grid", () => {
    const capacity = SPRITE_COLS * SPRITE_ROWS;
    expect(REACTIONS.length, "palette outgrew the sheet - run `pnpm run gen:emoji-sprite`").toBeLessThanOrEqual(capacity);
  });

  it("resolves the first, a middle and the last palette emoji to their own cells", () => {
    const first = REACTIONS[0] as string;
    const last = REACTIONS[REACTIONS.length - 1] as string;
    const middleIndex = Math.floor(REACTIONS.length / 2);
    const middle = REACTIONS[middleIndex] as string;

    expect(emojiSpriteCell(first)).toMatchObject({ col: 0, row: 0 });
    expect(emojiSpriteCell(middle)).toMatchObject({ col: middleIndex % SPRITE_COLS, row: Math.floor(middleIndex / SPRITE_COLS) });
    expect(emojiSpriteCell(last)).toMatchObject({ col: (REACTIONS.length - 1) % SPRITE_COLS, row: Math.floor((REACTIONS.length - 1) / SPRITE_COLS) });
  });

  it("gives every palette emoji a distinct cell", () => {
    const seen = new Set<string>();
    for (const emoji of REACTIONS) {
      const cell = emojiSpriteCell(emoji);
      expect(cell, `${emoji} has no sprite cell`).not.toBeNull();
      const key = `${cell?.col},${cell?.row}`;
      expect(seen.has(key), `${emoji} collides with an earlier cell at ${key}`).toBe(false);
      seen.add(key);
    }
    expect(seen.size).toBe(REACTIONS.length);
  });

  it("has no cell for an emoji the palette does not carry", () => {
    // The fallback contract: EmojiImg renders the OS glyph rather than a wrong sheet cell,
    // which is what a server-sent reaction outside the palette has to hit.
    expect(emojiSpriteCell("\u{1F9EA}\u{1F9EA}")).toBeNull();
    expect(emojiSpriteCell("not-an-emoji")).toBeNull();
  });
});
