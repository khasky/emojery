// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { applyCountsDelta, applyTotalDelta } from "./reaction-delta";

describe("applyCountsDelta", () => {
  it("adds a first reaction", () => {
    expect(applyCountsDelta({}, null, "😀")).toEqual({ "😀": 1 });
  });

  it("drops a key that reaches zero instead of keeping a 0 entry", () => {
    expect(applyCountsDelta({ "😀": 1 }, "😀", null)).toEqual({});
  });

  it("moves one count when switching reactions", () => {
    expect(applyCountsDelta({ "😀": 3, "😢": 1 }, "😀", "😢")).toEqual({ "😀": 2, "😢": 2 });
  });

  it("is a no-op when the reaction does not change", () => {
    expect(applyCountsDelta({ "😀": 2 }, "😀", "😀")).toEqual({ "😀": 2 });
  });

  // The same no-op where the breakdown has not been loaded yet (a cache miss, or a target the
  // server only reports a total for). Removing then re-adding would invent a count of 1 that
  // no read ever returned, and the trigger would paint it.
  it("invents nothing when the unchanged reaction has no count yet", () => {
    expect(applyCountsDelta({}, "😀", "😀")).toEqual({});
    expect(applyCountsDelta({ "😢": 4 }, "😀", "😀")).toEqual({ "😢": 4 });
  });

  it("is a no-op for no reaction either side", () => {
    expect(applyCountsDelta({ "😀": 2 }, null, null)).toEqual({ "😀": 2 });
  });

  it("never goes negative on a count the server never reported", () => {
    expect(applyCountsDelta({}, "😀", null)).toEqual({});
  });

  it("leaves the input untouched", () => {
    const counts = { "😀": 1 };
    applyCountsDelta(counts, "😀", "😢");
    expect(counts).toEqual({ "😀": 1 });
  });
});

describe("applyTotalDelta", () => {
  it("counts a new reactor", () => {
    expect(applyTotalDelta(4, null, "😀")).toBe(5);
  });

  it("uncounts a leaving reactor", () => {
    expect(applyTotalDelta(4, "😀", null)).toBe(3);
  });

  it("stays put while switching between reactions", () => {
    expect(applyTotalDelta(4, "😀", "😢")).toBe(4);
  });

  it("clamps at zero", () => {
    expect(applyTotalDelta(0, "😀", null)).toBe(0);
  });
});
