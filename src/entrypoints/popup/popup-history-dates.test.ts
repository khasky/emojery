// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every timestamp here is built with the LOCAL `new Date(y, m, d, h, min)` constructor and the
// clock is frozen to a local wall time, so the cases mean the same thing in every timezone the
// suite runs in - which is also the property under test: the History tab groups by the day the
// user reacted, never by a UTC day.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../../test/cold-module-reset";
import { fmtExactDate, historyDayKey, historyDayLabel } from "./popup-history-dates";

allowColdModuleReset();

// A Wednesday, deliberately mid-month and mid-year so no case straddles a month or year end
// by accident.
const TODAY = { y: 2026, m: 5, d: 17 } as const;
const at = (day: { y: number; m: number; d: number }, hours: number, minutes = 0): number => new Date(day.y, day.m, day.d, hours, minutes).getTime();
const daysBefore = (n: number) => ({ y: TODAY.y, m: TODAY.m, d: TODAY.d - n });

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at(TODAY, 12));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("historyDayKey", () => {
  it("files every hour of one local day under one key", () => {
    expect(historyDayKey(at(TODAY, 0, 0))).toBe(historyDayKey(at(TODAY, 23, 59)));
  });

  it("gives neighbouring days different keys", () => {
    expect(historyDayKey(at(TODAY, 0, 0))).not.toBe(historyDayKey(at(daysBefore(1), 23, 59)));
  });

  // 90 minutes apart, one local day apart: a key derived by dividing the epoch into 24h
  // blocks would put these two in the same group for most of the world.
  it("splits on local midnight, not on a UTC day boundary", () => {
    expect(historyDayKey(at(daysBefore(1), 23, 30))).not.toBe(historyDayKey(at(TODAY, 1, 0)));
  });
});

describe("historyDayLabel", () => {
  it("labels today and yesterday by name", () => {
    expect(historyDayLabel(at(TODAY, 9))).toBe("Today");
    expect(historyDayLabel(at(daysBefore(1), 9))).toBe("Yesterday");
  });

  it("labels anything older with a date instead", () => {
    const label = historyDayLabel(at(daysBefore(2), 9));
    expect(label).not.toBe("Today");
    expect(label).not.toBe("Yesterday");
    expect(label).not.toBe("");
  });

  // The boundary the naive "less than 24h ago is today" version gets wrong: 23:30 and 00:30
  // are one hour apart and belong to different days.
  it("calls late last night Yesterday, an hour after midnight", () => {
    vi.setSystemTime(at(TODAY, 0, 30));
    expect(historyDayLabel(at(daysBefore(1), 23, 30))).toBe("Yesterday");
  });

  // And its mirror: 23 hours apart, still the same day.
  it("calls this morning Today, late the same evening", () => {
    vi.setSystemTime(at(TODAY, 23, 30));
    expect(historyDayLabel(at(TODAY, 0, 30))).toBe("Today");
  });

  it("holds at both edges of today", () => {
    expect(historyDayLabel(at(TODAY, 0, 0))).toBe("Today");
    expect(historyDayLabel(at(TODAY, 23, 59))).toBe("Today");
  });
});

describe("fmtExactDate", () => {
  it("renders the timestamp's own day and year", () => {
    const text = fmtExactDate(at(TODAY, 9, 5));
    expect(text).toContain("2026");
    expect(text).toContain("17");
  });

  // The assert above passes on `toLocaleString()` too - both forms carry the year and the
  // day - so on its own it lets the whole Intl branch be deleted without a red test, and
  // with it the win the memoization exists for (constructing a formatter per row instead of
  // reusing one). Assert the SEAM instead: one formatter, built with these options,
  // reused across rows. That is the behaviour, and it holds in every locale.
  it("builds one formatter with the exact options and reuses it for every row", async () => {
    vi.resetModules();
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    try {
      const { fmtExactDate: freshFmt } = await import("./popup-history-dates");
      freshFmt(at(TODAY, 9, 5));
      freshFmt(at(TODAY, 10, 5));
      freshFmt(at(daysBefore(3), 11, 0));

      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]?.[1]).toMatchObject({ weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } finally {
      spy.mockRestore();
      vi.resetModules();
    }
  });

  // The formatter is cached at module level from its first call, and the top-level import's
  // earlier calls already filled that cache - hence a fresh module (resetModules) whose
  // first call sees the rejecting engine, rather than a stub around the call.
  it("falls back to toLocaleString on an engine that rejects the options", async () => {
    vi.resetModules();
    vi.stubGlobal(
      "Intl",
      class {
        constructor() {
          throw new RangeError("unsupported option");
        }
      },
    );
    try {
      const { fmtExactDate: withBrokenIntl } = await import("./popup-history-dates");
      expect(withBrokenIntl(at(TODAY, 9, 5))).toBe(new Date(at(TODAY, 9, 5)).toLocaleString());
    } finally {
      vi.unstubAllGlobals();
      vi.resetModules();
    }
  });
});
