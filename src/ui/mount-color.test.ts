// SPDX-License-Identifier: GPL-3.0-or-later
//
// The trigger's legibility rests on this math: the live-site check
// (e2e/theme-contrast.spec.ts) proves it against real pages, these vectors pin
// the arithmetic itself so a regression is caught without a browser.
import { describe, expect, it } from "vitest";
import { bestTextColor, colorfulness, composite, contrastRatio, DARK_TEXT, isSolidFill, LIGHT_TEXT, parseRgb, parseRgba, type Rgb, relativeLuminance, rgbaToRgbString } from "./mount-color";

const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];
// The channel values behind LIGHT_TEXT / DARK_TEXT.
const LIGHT_TEXT_RGB: Rgb = [228, 230, 235];
const DARK_TEXT_RGB: Rgb = [28, 30, 33];

describe("parseRgba - both syntaxes getComputedStyle returns", () => {
  it("reads the legacy comma form, with and without alpha", () => {
    expect(parseRgba("rgb(18, 52, 86)")).toEqual({ r: 18, g: 52, b: 86, a: 1 });
    expect(parseRgba("rgba(18, 52, 86, 0.5)")).toEqual({ r: 18, g: 52, b: 86, a: 0.5 });
  });

  it("reads the modern space-separated form with a slash alpha", () => {
    expect(parseRgba("rgb(18 52 86 / 0.25)")).toEqual({ r: 18, g: 52, b: 86, a: 0.25 });
    expect(parseRgba("rgb(18 52 86 / 40%)")).toEqual({ r: 18, g: 52, b: 86, a: 0.4 });
  });

  it("clamps channels and alpha into range", () => {
    expect(parseRgba("rgba(300, -20, 86, 4)")).toEqual({ r: 255, g: 0, b: 86, a: 1 });
  });

  it("returns null for anything that is not an rgb()/rgba() string", () => {
    for (const value of [undefined, "", "transparent", "#1c1e21", "color(display-p3 1 0 0)", "rgb(1, 2)"]) {
      expect(parseRgba(value), `${value}`).toBeNull();
    }
  });
});

describe("parseRgb - opaque channels only", () => {
  it("drops a fully transparent colour so a see-through surface never counts as a sample", () => {
    expect(parseRgb("rgba(255, 0, 0, 0)")).toBeNull();
    expect(parseRgb("rgba(255, 0, 0, 0.01)")).toEqual([255, 0, 0]);
  });
});

describe("isSolidFill - a painted box vs an icon button's hit-area", () => {
  it("treats the transparent icon buttons (X / FB / IG / Reddit) as unfilled", () => {
    expect(isSolidFill("rgba(0, 0, 0, 0)")).toBe(false);
    expect(isSolidFill("rgba(0, 0, 0, 0.02)")).toBe(false);
    expect(isSolidFill(undefined)).toBe(false);
  });

  it("treats a painted surface as filled", () => {
    expect(isSolidFill("rgb(26, 115, 232)")).toBe(true);
    expect(isSolidFill("rgba(0, 0, 0, 0.03)")).toBe(true);
  });
});

describe("WCAG contrast", () => {
  it("pins the two ends of the ratio scale", () => {
    expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 5);
    expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio([26, 115, 232], WHITE)).toBeCloseTo(contrastRatio(WHITE, [26, 115, 232]), 10);
  });

  it("pins relative luminance at both ends and at the sRGB linearization knee", () => {
    expect(relativeLuminance(BLACK)).toBeCloseTo(0, 10);
    expect(relativeLuminance(WHITE)).toBeCloseTo(1, 10);
    // Below the 0.03928 knee the curve is linear, not the 2.4 power.
    expect(relativeLuminance([2, 2, 2])).toBeCloseTo(2 / 255 / 12.92, 10);
  });
});

describe("bestTextColor - the legible one of the picker's two text colours", () => {
  it("picks dark text on a light surface and light text on a dark one", () => {
    expect(bestTextColor(WHITE)).toBe(DARK_TEXT);
    expect(bestTextColor(BLACK)).toBe(LIGHT_TEXT);
    expect(bestTextColor([24, 25, 26])).toBe(LIGHT_TEXT);
  });

  it("always returns the higher-contrast of the two, whatever the surface", () => {
    for (const bg of [WHITE, BLACK, [24, 25, 26], [26, 115, 232], [255, 153, 0], [101, 103, 107]] as Rgb[]) {
      const light = contrastRatio(bg, LIGHT_TEXT_RGB);
      const dark = contrastRatio(bg, DARK_TEXT_RGB);
      const picked = bestTextColor(bg) === LIGHT_TEXT ? light : dark;
      expect(picked, `bg ${bg.join(",")}`).toBe(Math.max(light, dark));
    }
  });

  // Known ceiling: with only two text colours, a mid-tone surface cannot reach
  // AA either way (#1a73e8 tops out at ~3.7:1). AA is guaranteed on the light
  // and dark canvases the picker actually renders against; widening it would
  // need a computed text colour, not a two-colour pick.
  it("clears AA body text (4.5:1) on the light and dark canvases", () => {
    for (const bg of [WHITE, BLACK, [24, 25, 26]] as Rgb[]) {
      const picked = bestTextColor(bg) === LIGHT_TEXT ? LIGHT_TEXT_RGB : DARK_TEXT_RGB;
      expect(contrastRatio(bg, picked), `bg ${bg.join(",")}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("colorfulness - neutral text vs a brand accent", () => {
  it("reads 0 for greys, black and white", () => {
    expect(colorfulness(BLACK)).toBe(0);
    expect(colorfulness(WHITE)).toBe(0);
    expect(colorfulness([128, 128, 128])).toBe(0);
  });

  it("puts Amazon's link blue above the 0.4 replace threshold, and body greys below it", () => {
    // The Amazon link-blue story lives on normalizeReadableColor in mount-style-math.ts.
    expect(colorfulness([0, 113, 133])).toBeGreaterThan(0.4);
    expect(colorfulness([28, 30, 33])).toBeLessThan(0.4);
    expect(colorfulness([101, 103, 107])).toBeLessThan(0.4);
  });
});

describe("composite - flatten translucent layers onto the canvas", () => {
  it("returns the layer unchanged when it is opaque", () => {
    expect(composite({ r: 10, g: 20, b: 30, a: 1 }, { r: 255, g: 255, b: 255, a: 1 })).toEqual({ r: 10, g: 20, b: 30, a: 1 });
  });

  it("blends a half-transparent black over white to mid grey", () => {
    const out = composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
    expect(out.a).toBeCloseTo(1, 10);
    expect(rgbaToRgbString(out)).toBe("rgb(128, 128, 128)");
  });

  it("stays fully transparent when neither layer paints", () => {
    expect(composite({ r: 1, g: 2, b: 3, a: 0 }, { r: 4, g: 5, b: 6, a: 0 })).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe("rgbaToRgbString", () => {
  it("rounds fractional channels the blend produces", () => {
    expect(rgbaToRgbString({ r: 127.4, g: 0.6, b: 254.5, a: 1 })).toBe("rgb(127, 1, 255)");
  });
});
