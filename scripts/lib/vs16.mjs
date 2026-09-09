// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The variation selector emojibase bakes into many root emoji, as an escape rather
// than the character itself: a literal U+FE0F is invisible in an editor and survives
// a normalization pass as an EMPTY pattern, which then matches everywhere.

const VS16 = /\uFE0F/g;

/** @param {string} s */
export const stripVS16 = (s) => s.replace(VS16, "");
