// SPDX-License-Identifier: GPL-3.0-or-later
//
// Emoji sentiment for the "Auto-press native buttons" setting: which native
// control (like/dislike) a picked reaction mirrors to, and the Facebook
// reaction each emoji maps to 1:1. Pure data + lookups; the DOM work lives in
// ui/native-trigger.ts.

export type Sentiment = "positive" | "negative" | "neutral";

type FbReactionName = "like" | "love" | "care" | "haha" | "wow" | "sad" | "angry";

export interface FbReaction {
  /** Position in Facebook's reactions flyout. The buttons' aria-labels
   *  localize and their content is a bare <canvas>, so the index is the only
   *  locale-independent handle (verified live: 0=Like .. 6=Angry). */
  readonly index: number;
  readonly name: FbReactionName;
  /** First entry is the canonical 1:1 emoji; the rest are aliases. */
  readonly emojis: readonly string[];
}

export const FB_REACTIONS: readonly FbReaction[] = [
  { index: 0, name: "like", emojis: ["👍"] },
  { index: 1, name: "love", emojis: ["❤️", "🧡", "💛", "💚", "💙", "💜", "🤎", "🤍", "💖", "💗", "💓", "💞", "💕", "💘", "💝", "💟", "❣️", "😍"] },
  { index: 2, name: "care", emojis: ["🤗", "🥰"] },
  { index: 3, name: "haha", emojis: ["😆", "😂", "🤣", "😄", "😁", "😅"] },
  { index: 4, name: "wow", emojis: ["😮", "😯", "😲", "😱", "🤯"] },
  { index: 5, name: "sad", emojis: ["😢", "😭", "😥", "😰", "💔"] },
  { index: 6, name: "angry", emojis: ["😡", "😠", "🤬", "💢"] },
];

export function resolveFbReaction(emoji: string): FbReaction | null {
  return FB_REACTIONS.find((r) => r.emojis.includes(emoji)) ?? null;
}

// Starting calibration for the sentiment lists; the user rearranges them via
// drag-and-drop in the popup. Everything not listed is neutral (not stored).
const DEFAULT_POSITIVE: readonly string[] = [
  "👍",
  "❤️",
  "🧡",
  "💛",
  "💚",
  "💙",
  "💜",
  "🤎",
  "🤍",
  "💖",
  "💗",
  "💓",
  "💞",
  "💕",
  "💘",
  "💝",
  "😍",
  "🥰",
  "🤩",
  "😘",
  "😊",
  "😀",
  "😃",
  "😄",
  "😁",
  "😆",
  "😂",
  "🤣",
  "🙂",
  "😉",
  "😇",
  "😋",
  "🤗",
  "👏",
  "🙌",
  "💪",
  "🤝",
  "🙏",
  "🔥",
  "⭐",
  "🌟",
  "✨",
  "💯",
  "🏆",
  "🥇",
  "✅",
  "🎉",
  "🎊",
  "🥳",
  "😎",
] as const;

const DEFAULT_NEGATIVE: readonly string[] = ["👎", "💔", "😠", "😡", "🤬", "💢", "😞", "😟", "🙁", "☹️", "😕", "😒", "🙄", "😤", "😢", "😭", "😥", "😰", "🤮", "🤢", "💩", "🖕", "❌", "⛔", "🚫", "🛑"] as const;

export interface EmojiSentiment {
  positive: string[];
  negative: string[];
}

export const DEFAULT_EMOJI_SENTIMENT: EmojiSentiment = {
  positive: [...DEFAULT_POSITIVE],
  negative: [...DEFAULT_NEGATIVE],
};

export function resolveSentiment(emoji: string, lists: EmojiSentiment): Sentiment {
  if (lists.positive.includes(emoji)) return "positive";
  if (lists.negative.includes(emoji)) return "negative";
  return "neutral";
}

/** The native action recorded per target in the auto_native_v1 store. */
export type NativeAutoAction = "like" | "dislike" | `fb:${FbReactionName}`;
