// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { accountLabel } from "./account-label";

describe("accountLabel", () => {
  it("is stable for the same account id", () => {
    expect(accountLabel("u_0123456789abcdef")).toBe(accountLabel("u_0123456789abcdef"));
  });

  // One emoji, so the mark costs the row no width worth speaking of and needs no
  // translating. A few carry a variation selector, which is part of the character.
  it("reads as a single emoji", () => {
    const mark = accountLabel("u_0123456789abcdef");
    expect([...mark].length).toBeLessThanOrEqual(2);
    expect(/\p{Extended_Pictographic}/u.test(mark)).toBe(true);
  });

  it("separates ids that differ by one character", () => {
    expect(accountLabel("u_aaaaaaaaaaaaaaa1")).not.toBe(accountLabel("u_aaaaaaaaaaaaaaa2"));
  });

  // A person signs in with a handful of accounts, and the mark only has to tell
  // THOSE apart - the provider and its number carry the rest.
  it("gives a realistic handful of accounts distinct marks", () => {
    const marks = new Set(Array.from({ length: 6 }, (_, i) => accountLabel(`u_${i.toString(16).padStart(32, "0")}`)));
    expect(marks.size).toBe(6);
  });

  // Spread, not just distinctness: a fold that clustered would hand the same few
  // marks out over and over however many accounts existed.
  it("spreads across most of the set it draws from", () => {
    const marks = new Set(Array.from({ length: 2_000 }, (_, i) => accountLabel(`u_${i.toString(16).padStart(32, "0")}`)));
    expect(marks.size).toBeGreaterThan(600);
  });
});
