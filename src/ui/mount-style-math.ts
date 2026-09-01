// SPDX-License-Identifier: GPL-3.0-or-later
//
// The value-level half of mount-style.ts: given lengths, colours and a style record -
// never an element, never a live box - decide the value to stamp on the host. It sits
// apart for the same reason mount-placement.ts does: mount-style.ts is
// coverage-excluded because its real work is reading a live page's computed styles, and
// excluding a whole file hides whatever pure logic sits in it. This module IS measured.
//
// The line to hold when adding here: a helper qualifies only if it takes plain values.
// The moment it needs `getComputedStyle`, a rect or a DOM walk, it belongs next door.
import { bestTextColor, colorfulness, contrastRatio, DARK_TEXT, LIGHT_TEXT, parseRgb, relativeLuminance } from "./mount-color";
import type { SiteButtonStyle } from "./mount-style-memory";

// Most common border-radius across the controls; ties broken toward the larger
// px value so a row of real controls wins over an odd wrapper.
export function pickRepresentativeRadius(radii: readonly (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of radii) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  let bestPx = -1;
  for (const [value, count] of counts) {
    const px = parseRadiusPx(value);
    if (count > bestCount || (count === bestCount && px > bestPx)) {
      best = value;
      bestCount = count;
      bestPx = px;
    }
  }
  return best;
}

// Leading px length of a radius, for tie-breaking only; non-px forms sort last (-1).
function parseRadiusPx(value: string): number {
  const pxMatch = /(-?[\d.]+)px/.exec(value);
  return pxMatch?.[1] ? Number.parseFloat(pxMatch[1]) : -1;
}

// Largest corner radius in px across the four corners, resolving each length: px kept as-is,
// % taken against the box axis (the horizontal token vs width, the vertical token vs height).
export function largestCornerPx(corners: string[], width: number, height: number): number {
  let max = -1;
  for (const corner of corners) {
    const [h, v] = corner.trim().split(/\s+/);
    const cornerPx = Math.max(resolveRadiusLen(h, width), resolveRadiusLen(v ?? h, height));
    if (cornerPx > max) max = cornerPx;
  }
  return max;
}

function resolveRadiusLen(token: string | undefined, axis: number): number {
  if (!token) return -1;
  const n = Number.parseFloat(token);
  if (!Number.isFinite(n)) return -1;
  return token.endsWith("%") ? (n / 100) * axis : n;
}

// Below this a copied radius reads as a sharp-cornered box next to the round emoji.
const MIN_TRIGGER_RADIUS_PX = 6;

// Floor a single-length radius so the trigger never looks sharp; multi-corner /
// percentage / slash forms pass through untouched (flooring them means parsing each corner).
export function clampRadius(value: string): string {
  const pxMatch = /^(-?[\d.]+)px$/.exec(value.trim());
  if (!pxMatch?.[1]) return value;
  const px = Number.parseFloat(pxMatch[1]);
  return Number.isFinite(px) && px < MIN_TRIGGER_RADIUS_PX ? `${MIN_TRIGGER_RADIUS_PX}px` : value;
}

// The smaller of the two sides (asymmetric padding shouldn't overshoot our slot), and only
// a real positive length - a zero-padding icon button spaces via gap/margin, mirrored separately.
// Takes the two properties rather than a whole CSSStyleDeclaration so the caller's
// `getComputedStyle` stays next door and this reads as the arithmetic it is.
export function readPaddingInline(cs: Pick<CSSStyleDeclaration, "paddingLeft" | "paddingRight">): string | undefined {
  const left = Number.parseFloat(cs.paddingLeft);
  const right = Number.parseFloat(cs.paddingRight);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
  const min = Math.min(left, right);
  return min > 0 ? `${Math.round(min)}px` : undefined;
}

export function marginPx(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

/**
 * Snap a sampled text colour to something readable on the sampled background,
 * mutating `style` in place. `theme` is passed in rather than read from
 * shared/theme so this stays a decision over values.
 */
export function normalizeReadableColor(style: SiteButtonStyle, theme: "dark" | "light"): void {
  if (!style.color) return;
  const bg = parseRgb(style.contrastBackgroundColor ?? style.backgroundColor);
  const fg = parseRgb(style.color);
  if (!fg) return;

  // A saturated sampled colour is a brand/link hue, not neutral text: Amazon's rating
  // strip exposes only links painted in its link blue, so the trigger copied that and the
  // reaction count rendered blue. The count reads as text, so snap a vivid hue to the
  // readable neutral; neutral greys fall through to the contrast/luminance handling below.
  if (colorfulness(fg) > 0.4) {
    style.color = bg ? bestTextColor(bg) : theme === "dark" ? LIGHT_TEXT : DARK_TEXT;
    return;
  }

  if (bg) {
    if (contrastRatio(bg, fg) < 4.5) style.color = bestTextColor(bg);
    return;
  }

  const fgLum = relativeLuminance(fg);
  if (theme === "dark" && fgLum < 0.35) style.color = LIGHT_TEXT;
  if (theme === "light" && fgLum > 0.85) style.color = DARK_TEXT;
}
