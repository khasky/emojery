// SPDX-License-Identifier: GPL-3.0-or-later
//
// Whether a computed CSS color paints anything - the one alpha read shared by
// the Threads liked-state heart (SVG fill) and the Facebook filled-chip probe
// (background-color), so the two cannot drift on a colour syntax again: the
// Facebook copy once took any `color(...)` value as painted, reading the
// `color(display-p3 ... / 0)` outline spelling as a fill.
//
// `none`, `transparent`, or a zero alpha in any syntax (`rgba(..., 0)`,
// `color(display-p3 ... / 0)`) is unpainted. An empty string means the color
// is unreadable, which reads UNKNOWN (null) - see the likePressed contract in
// shared/adapter.ts. The alpha is PARSED, not pattern-matched: an exact-"0"
// regex once read `rgba(0, 0, 0, 0.0)` and the `/`-separated syntax as filled,
// and a trailing-zero regex read opaque `rgb(0, 0, 0)` as an outline. A value
// carrying no readable alpha (3-component `rgb()`, `color()` without `/`,
// keywords, unknown syntaxes) is assumed painted rather than guessed away.
//
// Self-contained by contract: the site-auth suite injects this function into
// live pages via String(fn), so it must not close over module helpers.
export function isPaintedFill(value: string): boolean | null {
  const text = value.trim().toLowerCase();
  if (!text) return null;
  if (text === "none" || text === "transparent") return false;
  const inner = /^[a-z-]+\((.*)\)$/.exec(text)?.[1];
  if (inner === undefined) return true;
  const slash = inner.lastIndexOf("/");
  const alphaText = slash >= 0 ? inner.slice(slash + 1).trim() : text.startsWith("rgb") ? (inner.split(/[\s,]+/).filter(Boolean)[3] ?? "") : "";
  if (!alphaText) return true;
  const alpha = Number.parseFloat(alphaText);
  return !Number.isFinite(alpha) || alpha > 0;
}
