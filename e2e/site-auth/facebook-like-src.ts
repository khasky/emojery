// SPDX-License-Identifier: GPL-3.0-or-later
//
// One Facebook Like reader for every probe that needs one. Injected source cannot
// import, so what is shared is the TEXT: this module builds it in Node from the
// SHIPPED adapter helpers, and each suite pastes it into its own probe body.
//
// Every clause below is load-bearing, and each was a live miss before it existed:
//   - the count summary ("Like: 3 people") sits in the same row as the real button,
//     so scoping to the row does not exclude it;
//   - a "Suggested for you" card carries its own Like inside the audited unit;
//   - the REMOVE form IS the reacted Like and wins over the chevron rejection. Both
//     carry "реакц" in RU/UA ("Видалити реакцію У захваті" vs "Змінити реакцію..."),
//     so rejecting on the wording first makes an already-reacted post unreadable.
//     EN never shows it: "Remove Love" has no "reaction" in it.
import { FB_REACTION_MENU_ARIA, FB_REMOVE_RE, FB_STEMS, fbLikeLabelPressed } from "../../src/adapters/facebook";

export const fnSrc = (fn: (...args: never[]) => unknown): string => String(fn);
export const reSrc = (re: RegExp): string => re.toString();

// Declares `readFbLabel(el)`, `isFbLikeButton(el)` and `fbLikeLabelPressed(label)`
// in the injected scope. Paste once per probe body, before anything that calls them.
export const FB_LIKE_READER_SRC = `
  const FB_REMOVE_RE = ${reSrc(FB_REMOVE_RE)};
  const FB_STEMS = { like: ${reSrc(FB_STEMS.like)} };
  const FB_REACTION_MENU_ARIA = ${reSrc(FB_REACTION_MENU_ARIA)};
  const fbLikeLabelPressed = ${fnSrc(fbLikeLabelPressed)};
  const readFbLabel = (el) => (el.getAttribute('aria-label') || '').trim();
  const isFbLikeButton = (el) => {
    const label = readFbLabel(el);
    if (!label || /suggested/i.test(label) || /:\\s*\\d/.test(label)) return false;
    const pressed = fbLikeLabelPressed(label);
    if (pressed === null) return false;
    return pressed === true || !FB_REACTION_MENU_ARIA.test(label);
  };`;
