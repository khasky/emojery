// SPDX-License-Identifier: GPL-3.0-or-later
//
// The wording belongs to Intl, so what is asserted here is the BUCKET each gap falls
// in - the unit and the number - rather than the English it happens to produce under
// the runner's locale.

import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time";

const MINUTE = 60_000;
const HOUR = 3_600_000;
// Local noon, so no case sits close enough to midnight for a timezone to move it.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m, d, h).getTime();
const NOW = at(2026, 5, 17);

describe("relativeTime", () => {
  it("counts in minutes for the first hour, and never says zero", () => {
    expect(relativeTime(NOW - 12 * MINUTE, NOW)).toBe("12 minutes ago");
    expect(relativeTime(NOW - 59 * MINUTE, NOW)).toBe("59 minutes ago");
    // A sign-in seconds old is still "a minute ago", never "0 minutes ago".
    expect(relativeTime(NOW - 1_000, NOW)).toBe("1 minute ago");
    expect(relativeTime(NOW, NOW)).toBe("1 minute ago");
  });

  it("counts in hours for the rest of the same day", () => {
    expect(relativeTime(NOW - 3 * HOUR, NOW)).toBe("3 hours ago");
  });

  it("names yesterday rather than counting it", () => {
    expect(relativeTime(at(2026, 5, 16), NOW)).toBe("yesterday");
    // Late yesterday is still yesterday, not "18 hours ago": the reader counts days,
    // and the boundary is local midnight.
    expect(relativeTime(at(2026, 5, 16, 23), NOW)).toBe("yesterday");
  });

  it("counts days, then weeks, then months", () => {
    expect(relativeTime(at(2026, 5, 15), NOW)).toBe("2 days ago");
    expect(relativeTime(at(2026, 5, 11), NOW)).toBe("6 days ago");
    expect(relativeTime(at(2026, 5, 10), NOW)).toBe("1 week ago");
    expect(relativeTime(at(2026, 5, 3), NOW)).toBe("2 weeks ago");
    expect(relativeTime(at(2026, 4, 10), NOW)).toBe("1 month ago");
    expect(relativeTime(at(2026, 2, 10), NOW)).toBe("3 months ago");
  });

  it("stops at a year, however much longer it has been", () => {
    expect(relativeTime(at(2025, 5, 17), NOW)).toBe("1 year ago");
    expect(relativeTime(at(2019, 0, 1), NOW)).toBe("1 year ago");
  });

  it("reads a timestamp from the future as the present minute", () => {
    expect(relativeTime(NOW + 5 * HOUR, NOW)).toBe("1 minute ago");
  });
});
