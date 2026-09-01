// SPDX-License-Identifier: GPL-3.0-or-later

// A cheap bail before the regex, not the rule that decides the outcome: the pattern
// below already caps a match well under this, so anything the length rejects the
// regex would reject too. It exists so a megabyte of `navigator.language`-shaped
// junk never reaches the matcher at all. RFC 5646 sizes its recommended buffer here.
const MAX_BCP47_LENGTH = 35;

/** BCP-47 tags only, with `_` separators normalized to `-`. */
export function normalizeLanguageTag(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const lang = value.trim().replace(/_/g, "-");
  if (!lang || lang.length > MAX_BCP47_LENGTH) return undefined;
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(lang) ? lang : undefined;
}
