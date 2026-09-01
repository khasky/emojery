// SPDX-License-Identifier: GPL-3.0-or-later
//
// Colour math behind the trigger's visual blending: parse the CSS colour strings
// `getComputedStyle` returns, flatten translucent layers, and pick a legible text
// colour. Pure functions over numbers and strings - no DOM, no theme, no storage -
// so the WCAG contrast rules the trigger's legibility rests on are unit-testable
// without laying out a page (the live-site check stays e2e/theme-contrast.spec.ts).

export interface RgbaColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

export type Rgb = [number, number, number];

/** The picker's two text colours - the same pair the stylesheet uses. */
export const LIGHT_TEXT = "#e4e6eb";
export const DARK_TEXT = "#1c1e21";

const LIGHT_TEXT_RGB: Rgb = [228, 230, 235];
const DARK_TEXT_RGB: Rgb = [28, 30, 33];

// HSV-style saturation: 0 for greys/black/white, approaching 1 for vivid hues.
// Used to tell a neutral text colour (keep) from a brand/link accent (replace).
export function colorfulness([r, g, b]: Rgb): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

// Source-over composite of a translucent layer onto its backdrop.
export function composite(fg: RgbaColor, bg: RgbaColor): RgbaColor {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

export function rgbaToRgbString(color: RgbaColor): string {
  return `rgb(${Math.round(color.r)}, ${Math.round(color.g)}, ${Math.round(color.b)})`;
}

// Accepts both CSS colour syntaxes `getComputedStyle` may return: legacy
// `rgba(r, g, b, a)` and the modern space-separated `rgb(r g b / a)`.
export function parseRgba(value: string | undefined): RgbaColor | null {
  if (!value) return null;
  const rgbMatch = value.match(/^rgba?\(([^)]+)\)$/i);
  if (!rgbMatch?.[1]) return null;
  const body = rgbMatch[1].trim();
  const alphaParts = body.split("/");
  const channels = alphaParts[0]!
    .trim()
    .split(/[,\s]+/)
    .filter(Boolean)
    .map((part) => Number.parseFloat(part));
  if (channels.length < 3) return null;
  const commaParts = body.split(",").map((part) => part.trim());
  const alphaRaw = alphaParts.length > 1 ? alphaParts[1] : commaParts.length >= 4 ? commaParts[3] : "1";
  const alpha = parseAlpha(alphaRaw ?? "1");
  const [r, g, b] = channels;
  if (![r, g, b, alpha].every((n) => Number.isFinite(n))) return null;
  return {
    r: clampChannel(r!),
    g: clampChannel(g!),
    b: clampChannel(b!),
    a: Math.min(1, Math.max(0, alpha)),
  };
}

/** Opaque channels of a colour, or null when it is absent or fully transparent. */
export function parseRgb(value: string | undefined): Rgb | null {
  const color = parseRgba(value);
  if (!color || color.a === 0) return null;
  return [color.r, color.g, color.b];
}

// A native control is a real "filled" surface only when its background is actually painted
// (alpha above a hair); transparent icon buttons report rgba(...,0) - see picker.css's hit-box
// note for why the trigger must not size to their box.
export function isSolidFill(bg: string | undefined): boolean {
  const color = parseRgba(bg);
  return !!color && color.a > 0.02;
}

function parseAlpha(value: string): number {
  const trimmed = value.trim();
  if (trimmed.endsWith("%")) {
    return Number.parseFloat(trimmed) / 100;
  }
  return Number.parseFloat(trimmed);
}

function clampChannel(value: number): number {
  return Math.min(255, Math.max(0, value));
}

/** WCAG 2.x contrast ratio, 1..21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

export function bestTextColor(bg: Rgb): string {
  return contrastRatio(bg, LIGHT_TEXT_RGB) >= contrastRatio(bg, DARK_TEXT_RGB) ? LIGHT_TEXT : DARK_TEXT;
}

/** WCAG 2.x relative luminance, 0..1. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const linear = [r, g, b].map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}
