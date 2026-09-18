// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { accountLabel } from "./account-label";

describe("accountLabel", () => {
  it("is stable for the same account id", () => {
    expect(accountLabel("u_0123456789abcdef")).toBe(accountLabel("u_0123456789abcdef"));
  });

  it("reads as two lowercase words", () => {
    expect(accountLabel("u_0123456789abcdef")).toMatch(/^[a-z]+-[a-z]+$/);
  });

  it("separates ids that differ by one character", () => {
    expect(accountLabel("u_aaaaaaaaaaaaaaa1")).not.toBe(accountLabel("u_aaaaaaaaaaaaaaa2"));
  });

  // The point of 256x256: a person signs in with a handful of accounts, and two of
  // them sharing a label would make the label worse than useless.
  it("spreads a realistic set of ids across distinct labels", () => {
    const labels = new Set(Array.from({ length: 200 }, (_, i) => accountLabel(`u_${i.toString(16).padStart(32, "0")}`)));
    expect(labels.size).toBeGreaterThan(195);
  });
});
