// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { deriveOwnReactionDisplay, formatCount } from "./picker-counts";

// Right after voting, the fetched aggregate can still read total 0 for the user's own
// reaction. The display must still reflect the user's own reaction in that window
// without double-counting later.
describe("deriveOwnReactionDisplay", () => {
  it("unauthed / no own reaction: passes counts + total through unchanged", () => {
    const r = deriveOwnReactionDisplay({ "👍": 3 }, 3, null);
    expect(r).toEqual({ counts: { "👍": 3 }, total: 3 });
  });

  it("own reaction not yet in the aggregate (stale fold): adds it (+1, count 1)", () => {
    const r = deriveOwnReactionDisplay({}, 0, "❤️");
    expect(r).toEqual({ counts: { "❤️": 1 }, total: 1 });
  });

  it("own reaction alongside others but not folded yet: adds own without touching others", () => {
    const r = deriveOwnReactionDisplay({ "👍": 5 }, 5, "❤️");
    expect(r).toEqual({ counts: { "👍": 5, "❤️": 1 }, total: 6 });
  });

  it("own reaction already counted: no-op (never double-counts)", () => {
    const r = deriveOwnReactionDisplay({ "❤️": 1 }, 1, "❤️");
    expect(r).toEqual({ counts: { "❤️": 1 }, total: 1 });
  });

  it("own reaction already counted among many: unchanged", () => {
    const r = deriveOwnReactionDisplay({ "👍": 4, "❤️": 2 }, 6, "❤️");
    expect(r).toEqual({ counts: { "👍": 4, "❤️": 2 }, total: 6 });
  });
});

describe("formatCount", () => {
  it("below 1,000: renders the exact number", () => {
    expect(formatCount(0)).toBe("0");
    expect(formatCount(1)).toBe("1");
    expect(formatCount(999)).toBe("999");
  });

  it("thousands: one decimal, trailing .0 dropped", () => {
    expect(formatCount(1_000)).toBe("1K");
    expect(formatCount(1_500)).toBe("1.5K");
    expect(formatCount(12_345)).toBe("12.3K");
    expect(formatCount(999_000)).toBe("999K");
  });

  it("millions: one decimal, trailing .0 dropped", () => {
    expect(formatCount(1_000_000)).toBe("1M");
    expect(formatCount(2_500_000)).toBe("2.5M");
    expect(formatCount(12_000_000)).toBe("12M");
  });

  it("billions: one decimal, trailing .0 dropped", () => {
    expect(formatCount(1_000_000_000)).toBe("1B");
    expect(formatCount(1_500_000_000)).toBe("1.5B");
    expect(formatCount(2_000_000_000)).toBe("2B");
  });

  it("tier boundaries: values toFixed rounds up to 1000.0 jump to the next tier", () => {
    expect(formatCount(999_949)).toBe("999.9K");
    expect(formatCount(999_950)).toBe("1M");
    expect(formatCount(999_949_999)).toBe("999.9M");
    expect(formatCount(999_950_000)).toBe("1B");
  });
});
