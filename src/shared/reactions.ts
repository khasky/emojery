// SPDX-License-Identifier: GPL-3.0-or-later

import categoryData from "./__data__/emoji-categories.json";
import type { I18nKey } from "./i18n";

export type Reaction = string;
export type ReactionCounts = Record<string, number>;

export interface TargetCounts {
  counts: ReactionCounts;
  total: number;
  loaded: number;
  hasMore: boolean;
  myReaction?: Reaction | null;
}

export const DEFAULT_BREAKDOWN_LIMIT = 6;

interface EmojiCategory {
  readonly nameKey: I18nKey;
  // Representative glyph for the category nav bar. Always one of the category's
  // own `emojis`, so it is guaranteed to exist in the generated sprite sheet.
  readonly icon: string;
  readonly emojis: readonly string[];
}

// The palette itself lives in __data__/emoji-categories.json rather than in this
// file: scripts/build-emoji-sprite.mjs and scripts/copy-emoji-locales.mjs both
// need the same list at build time (both read it through
// scripts/lib/emoji-palette.mjs), and reading JSON keeps them off a regex over
// TypeScript source that any reformat could quietly break.
//
// JSON widens `nameKey` to `string`, so the cast is the one unchecked step here;
// reactions.test.ts pins that every key is a real i18n key and every icon belongs
// to its own category.
export const CATEGORIES: readonly EmojiCategory[] = categoryData as readonly EmojiCategory[];

export const REACTIONS: readonly string[] = CATEGORIES.flatMap((c) => c.emojis);
