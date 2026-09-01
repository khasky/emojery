// SPDX-License-Identifier: GPL-3.0-or-later
//
// The value-level decisions mount-style.ts stamps on the trigger host. Everything
// here takes plain values, so none of it needs a laid-out page - which is the whole
// reason it lives outside the coverage-excluded mount-style.ts.
import { describe, expect, it } from "vitest";
import { DARK_TEXT, LIGHT_TEXT } from "./mount-color";
import { clampRadius, largestCornerPx, marginPx, normalizeReadableColor, pickRepresentativeRadius, readPaddingInline } from "./mount-style-math";
import type { SiteButtonStyle } from "./mount-style-memory";

describe("largestCornerPx - resolve % radii to px against the box", () => {
  it("keeps px corners, taking the largest", () => {
    // Segmented pill (`18px 0 0 18px`) collapses to its full-pill corner.
    expect(largestCornerPx(["18px", "0px", "0px", "18px"], 80, 40)).toBe(18);
  });

  it("resolves a circle's 50% to half the box, not a maximal pill", () => {
    // YouTube's round more-menu button: 50% of a 40px box is 20px, comparable to the row's
    // ~18px pills - not the +Infinity roundness that used to hijack the trigger's shape and
    // bulge its ends into an ellipse.
    expect(largestCornerPx(["50%", "50%", "50%", "50%"], 40, 40)).toBe(20);
  });

  it("resolves an elliptical corner per axis (h vs width, v vs height)", () => {
    expect(largestCornerPx(["50% 25%", "0px", "0px", "0px"], 80, 40)).toBe(40);
  });

  it("returns -1 when no corner is a real length", () => {
    expect(largestCornerPx(["", "", "", ""], 80, 40)).toBe(-1);
  });
});

describe("pickRepresentativeRadius - the row's shape, not a stray wrapper's", () => {
  it("takes the most common radius", () => {
    expect(pickRepresentativeRadius(["18px", "18px", "4px"])).toBe("18px");
  });

  it("breaks a tie toward the larger px value, so real controls beat a square wrapper", () => {
    expect(pickRepresentativeRadius(["0px", "18px"])).toBe("18px");
  });

  it("sorts a non-px form last in a tie but still returns it when it is alone", () => {
    expect(pickRepresentativeRadius(["50%", "8px"])).toBe("8px");
    expect(pickRepresentativeRadius(["50%"])).toBe("50%");
  });

  it("ignores entries that carry no radius at all", () => {
    expect(pickRepresentativeRadius([undefined, undefined, "6px"])).toBe("6px");
    expect(pickRepresentativeRadius([undefined, undefined])).toBeUndefined();
    expect(pickRepresentativeRadius([])).toBeUndefined();
  });
});

describe("clampRadius - never let the trigger read as a sharp box", () => {
  it("floors a small single-length radius to the 6px minimum", () => {
    expect(clampRadius("0px")).toBe("6px");
    expect(clampRadius("2px")).toBe("6px");
    expect(clampRadius(" 3.5px ")).toBe("6px");
  });

  it("leaves a radius already at or above the floor alone", () => {
    expect(clampRadius("6px")).toBe("6px");
    expect(clampRadius("18px")).toBe("18px");
  });

  // Flooring a multi-corner or percentage form would mean parsing each corner, so
  // those pass through as authored rather than being partially rewritten.
  it("passes multi-corner, percentage and slash forms through untouched", () => {
    expect(clampRadius("50%")).toBe("50%");
    expect(clampRadius("18px 0 0 18px")).toBe("18px 0 0 18px");
    expect(clampRadius("10px / 20px")).toBe("10px / 20px");
  });
});

describe("readPaddingInline - mirror the native control's horizontal rhythm", () => {
  it("takes the smaller side so asymmetric padding cannot overshoot the slot", () => {
    expect(readPaddingInline({ paddingLeft: "12px", paddingRight: "20px" })).toBe("12px");
  });

  it("rounds to whole px", () => {
    expect(readPaddingInline({ paddingLeft: "11.4px", paddingRight: "11.4px" })).toBe("11px");
  });

  // A zero-padding icon button spaces its row via gap/margin, which applyHostSpacing
  // mirrors separately - reporting 0px here would fight that.
  it("reports nothing for a zero or unreadable padding", () => {
    expect(readPaddingInline({ paddingLeft: "0px", paddingRight: "8px" })).toBeUndefined();
    expect(readPaddingInline({ paddingLeft: "", paddingRight: "8px" })).toBeUndefined();
    expect(readPaddingInline({ paddingLeft: "auto", paddingRight: "auto" })).toBeUndefined();
  });
});

describe("marginPx", () => {
  it("reads a px length and floors a negative margin at zero", () => {
    expect(marginPx("12px")).toBe(12);
    expect(marginPx("-8px")).toBe(0);
  });

  it("treats an unreadable margin as none", () => {
    expect(marginPx("auto")).toBe(0);
    expect(marginPx("")).toBe(0);
  });
});

describe("normalizeReadableColor - the sampled colour has to stay legible", () => {
  it("leaves a style with no sampled colour alone", () => {
    const style: SiteButtonStyle = { backgroundColor: "rgb(255, 255, 255)" };
    normalizeReadableColor(style, "light");
    expect(style.color).toBeUndefined();
  });

  // The Amazon link-blue story lives on normalizeReadableColor in mount-style-math.ts.
  it("snaps a saturated brand hue to the readable colour for its background", () => {
    const style: SiteButtonStyle = { color: "rgb(0, 113, 133)", contrastBackgroundColor: "rgb(255, 255, 255)" };
    normalizeReadableColor(style, "light");
    expect(style.color).toBe(DARK_TEXT);
  });

  it("falls back to the theme neutral when a saturated hue has no background to judge against", () => {
    const style: SiteButtonStyle = { color: "rgb(0, 113, 133)" };
    normalizeReadableColor(style, "dark");
    expect(style.color).toBe(LIGHT_TEXT);
  });

  it("rewrites a neutral colour that fails contrast against its background", () => {
    const style: SiteButtonStyle = { color: "rgb(200, 200, 200)", contrastBackgroundColor: "rgb(255, 255, 255)" };
    normalizeReadableColor(style, "light");
    expect(style.color).toBe(DARK_TEXT);
  });

  it("keeps a neutral colour that already passes contrast", () => {
    const style: SiteButtonStyle = { color: "rgb(40, 40, 40)", contrastBackgroundColor: "rgb(255, 255, 255)" };
    normalizeReadableColor(style, "light");
    expect(style.color).toBe("rgb(40, 40, 40)");
  });

  // No background sampled: the only cue left is the theme, so a colour that would
  // vanish into it gets swapped and anything mid-range is left as authored.
  it("lifts a too-dark colour on a dark theme and darkens a too-light one on light", () => {
    const onDark: SiteButtonStyle = { color: "rgb(20, 20, 20)" };
    normalizeReadableColor(onDark, "dark");
    expect(onDark.color).toBe(LIGHT_TEXT);

    const onLight: SiteButtonStyle = { color: "rgb(250, 250, 250)" };
    normalizeReadableColor(onLight, "light");
    expect(onLight.color).toBe(DARK_TEXT);

    // Relative luminance ~0.46, inside both bands (>0.35, <0.85), so neither theme touches it.
    const midtone: SiteButtonStyle = { color: "rgb(180, 180, 180)" };
    normalizeReadableColor(midtone, "dark");
    expect(midtone.color).toBe("rgb(180, 180, 180)");
    normalizeReadableColor(midtone, "light");
    expect(midtone.color).toBe("rgb(180, 180, 180)");
  });

  it("leaves an unparseable colour as authored rather than guessing", () => {
    const style: SiteButtonStyle = { color: "currentColor" };
    normalizeReadableColor(style, "light");
    expect(style.color).toBe("currentColor");
  });
});
