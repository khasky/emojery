// SPDX-License-Identifier: GPL-3.0-or-later
import { emojiSpriteCell, registerPendingSpriteImg, spriteUrlPending } from "./emoji-sprite";

interface Props {
  emoji: string;
}

/** The glyph character always stays in the DOM (`.khasky-emojery-emoji-char`) so
 *  a11y, copy/paste and e2e `textContent` selectors keep working; visually it is
 *  the OS-font fallback. On a host stamped `data-khasky-emojery-emoji="sprite"`
 *  the stylesheet hides it and crops the matching cell out of the sheet <img>
 *  instead; emoji outside the sheet keep the glyph.
 *
 *  While the sheet URL is still resolving (Firefox/Safari mint it asynchronously)
 *  the <img> renders src-less and registered, so the settled probe can back-fill
 *  it - without this, an early render (counter chip on a warm load) kept the OS
 *  glyph forever. */
export function EmojiImg({ emoji }: Props) {
  const cell = emojiSpriteCell(emoji);
  if (!cell) return <>{emoji}</>;

  return (
    <span
      class="khasky-emojery-emoji"
      style={{
        "--khasky-emojery-col": cell.col,
        "--khasky-emojery-row": cell.row,
      }}
    >
      {cell.url || spriteUrlPending() ? (
        <img
          class="khasky-emojery-emoji-img"
          src={cell.url ?? undefined}
          alt=""
          decoding="async"
          draggable={false}
          ref={(el: HTMLImageElement | null) => {
            if (el && !cell.url) registerPendingSpriteImg(el);
          }}
        />
      ) : null}
      <span class="khasky-emojery-emoji-char">{emoji}</span>
    </span>
  );
}
