// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseRetryAfterSeconds } from "./retry-after";

afterEach(() => {
  vi.useRealTimers();
});

describe("parseRetryAfterSeconds", () => {
  it("parses delta-seconds", () => {
    expect(parseRetryAfterSeconds("0")).toBe(0);
    expect(parseRetryAfterSeconds("120")).toBe(120);
    // Number() trims, so a padded header is still a delta rather than falling through.
    expect(parseRetryAfterSeconds(" 120 ")).toBe(120);
  });

  // The two branches are tried in order, and for "0" they disagree: V8 reads a bare "0" as
  // the year 2000, so a delta that stopped taking the numeric branch would come back as the
  // distance to that year. Today's clock hides it - the date is in the past and the clamp
  // flattens it back to 0 - so the precedence is pinned from a clock where the two answers
  // differ, not from one where the bug is invisible.
  it("reads a bare number as delta-seconds, never as a date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("1990-01-01T00:00:00Z"));
    expect(parseRetryAfterSeconds("0")).toBe(0);
    expect(parseRetryAfterSeconds("00")).toBe(0);
  });

  it("parses an HTTP-date relative to now, clamped at zero", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-04T00:00:00Z"));
    expect(parseRetryAfterSeconds("Tue, 04 Aug 2026 00:01:30 GMT")).toBe(90);
    // A date already in the past must not yield a negative delay.
    expect(parseRetryAfterSeconds("Mon, 03 Aug 2026 23:59:00 GMT")).toBe(0);
  });

  it("rejects garbage and absent headers", () => {
    expect(parseRetryAfterSeconds("soon")).toBeUndefined();
    // A negative delta is invalid per RFC; V8's Date.parse happens to read "-5"
    // as a year, so it lands in the date branch and clamps to an immediate
    // retry - harmless, pinned here so a change is a conscious one.
    expect(parseRetryAfterSeconds("-5")).toBe(0);
    expect(parseRetryAfterSeconds("")).toBeUndefined();
    expect(parseRetryAfterSeconds(null)).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
  });
});
