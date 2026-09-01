// SPDX-License-Identifier: GPL-3.0-or-later
//
// How the History tab turns a timestamp into text: the day a row is filed under, that day's
// heading, and the exact date behind the relative label. Kept out of popup-history.tsx so the
// decisions can be asserted without rendering the list - same split as popup-view-state.ts.
// Everything here is local-time on purpose: a row is filed under the day the USER reacted.

import { t } from "../../shared/i18n";

const DAY_MS = 86_400_000;

// One formatter per option set, reused for the life of the popup: constructing an
// Intl.DateTimeFormat is orders of magnitude dearer than formatting with one already built,
// and the list re-renders on every state change. `null` records an engine that rejected the
// options, so the caller's plain-toLocale fallback is taken without retrying per row.
function lazyDateFormat(options: Intl.DateTimeFormatOptions): () => Intl.DateTimeFormat | null {
  let cached: Intl.DateTimeFormat | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      cached = new Intl.DateTimeFormat(navigator.language || undefined, options);
    } catch {
      cached = null;
    }
    return cached;
  };
}

const exactDateFormat = lazyDateFormat({ weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const dayLabelFormat = lazyDateFormat({ weekday: "short", month: "short", day: "numeric" });

// For the date tooltip: the relative label it hangs off ("19h") is only approximate.
export function fmtExactDate(ts: number): string {
  const date = new Date(ts);
  return exactDateFormat()?.format(date) ?? date.toLocaleString();
}

/** Groups rows into day headings. Local calendar fields, not a UTC-day divide: two rows the
 *  user made on the same evening must not split across headings because one crossed midnight
 *  UTC. Only ever compared for equality, so the shape is free. */
export function historyDayKey(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function historyDayLabel(ts: number): string {
  const midnight = new Date(ts);
  midnight.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Both ends are local midnight, so a DST shift makes this span 23 or 25 hours: rounding is
  // what keeps such a day one day apart instead of 0.96 or 1.04 of one.
  const diffDays = Math.round((today.getTime() - midnight.getTime()) / DAY_MS);
  if (diffDays === 0) return t("historyToday");
  if (diffDays === 1) return t("historyYesterday");
  return dayLabelFormat()?.format(midnight) ?? midnight.toLocaleDateString();
}
