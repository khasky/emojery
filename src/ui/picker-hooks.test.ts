// SPDX-License-Identifier: GPL-3.0-or-later
//
// The emoji grid's index math. The rendered keyboard walk is the browser suite's
// (picker.browser.test.tsx drives ArrowDown/ArrowRight in real WebKit); what it does
// NOT reach is the clamping at both ends and the no-current-item entry points, which
// are pure arithmetic and belong here.
import { describe, expect, it } from "vitest";
import { gridTargetIndex } from "./picker-hooks";

// One 15-item grid at the picker's 6 columns: rows are 0-5, 6-11, 12-14.
const COUNT = 15;

describe("gridTargetIndex", () => {
  it("sends Home/End to the ends regardless of the current item", () => {
    expect(gridTargetIndex("first", 7, COUNT)).toBe(0);
    expect(gridTargetIndex("last", 7, COUNT)).toBe(COUNT - 1);
    expect(gridTargetIndex("first", -1, COUNT)).toBe(0);
    expect(gridTargetIndex("last", -1, COUNT)).toBe(COUNT - 1);
  });

  it("steps one cell horizontally", () => {
    expect(gridTargetIndex("next", 3, COUNT)).toBe(4);
    expect(gridTargetIndex("previous", 3, COUNT)).toBe(2);
  });

  it("steps a full visual row vertically", () => {
    expect(gridTargetIndex("rowNext", 2, COUNT)).toBe(8);
    expect(gridTargetIndex("rowPrev", 8, COUNT)).toBe(2);
  });

  it("clamps at both ends instead of wrapping", () => {
    expect(gridTargetIndex("next", COUNT - 1, COUNT)).toBe(COUNT - 1);
    expect(gridTargetIndex("previous", 0, COUNT)).toBe(0);
    // The last row is short (12-14), so a row step from it lands on the final cell.
    expect(gridTargetIndex("rowNext", 12, COUNT)).toBe(COUNT - 1);
    expect(gridTargetIndex("rowPrev", 3, COUNT)).toBe(0);
  });

  it("enters the grid from the near end when nothing is focused yet", () => {
    expect(gridTargetIndex("next", -1, COUNT)).toBe(0);
    expect(gridTargetIndex("rowNext", -1, COUNT)).toBe(0);
    expect(gridTargetIndex("previous", -1, COUNT)).toBe(COUNT - 1);
    expect(gridTargetIndex("rowPrev", -1, COUNT)).toBe(COUNT - 1);
  });
});
