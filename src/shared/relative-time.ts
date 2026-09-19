// SPDX-License-Identifier: GPL-3.0-or-later
//
// How long ago something happened, in the reader's language. Intl.RelativeTimeFormat
// carries the plural rules and the wording of all 26 locales, so none of this needs a
// message of its own - and a locale the engine does not know falls back to its own
// default rather than to English strings we would have had to invent.
//
// Days are counted between LOCAL midnights, not by dividing the elapsed milliseconds:
// something from 23:50 yesterday is yesterday at 00:10, and a DST shift must not make
// a day 0.96 of one.

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

// One formatter per numeric mode, reused: building an Intl.RelativeTimeFormat costs
// orders of magnitude more than formatting with one. `null` records an engine that
// rejected the options, so the caller's fallback is taken without retrying.
const cache = new Map<Intl.RelativeTimeFormatNumeric, Intl.RelativeTimeFormat | null>();
function formatter(numeric: Intl.RelativeTimeFormatNumeric): Intl.RelativeTimeFormat | null {
  const hit = cache.get(numeric);
  if (hit !== undefined) return hit;
  let built: Intl.RelativeTimeFormat | null;
  try {
    built = new Intl.RelativeTimeFormat(navigator.language || undefined, { numeric, style: "long" });
  } catch {
    built = null;
  }
  cache.set(numeric, built);
  return built;
}

function ago(value: number, unit: Intl.RelativeTimeFormatUnit, numeric: Intl.RelativeTimeFormatNumeric = "always"): string | null {
  return formatter(numeric)?.format(-value, unit) ?? null;
}

function localDaysBetween(from: number, to: number): number {
  const a = new Date(from);
  a.setHours(0, 0, 0, 0);
  const b = new Date(to);
  b.setHours(0, 0, 0, 0);
  return Math.round((b.getTime() - a.getTime()) / DAY_MS);
}

/** "12 minutes ago", "yesterday", "2 weeks ago" - never finer than a minute and never
 *  coarser than a year, since an account last used in 2019 and one used in 2021 are
 *  equally "a long time ago" to the reader choosing between them. A clock that has
 *  gone backwards (a device whose time was corrected) reads as the present minute
 *  rather than as the future. */
export function relativeTime(at: number, now: number = Date.now()): string | null {
  const elapsed = Math.max(0, now - at);
  if (elapsed < HOUR_MS) return ago(Math.max(1, Math.floor(elapsed / MINUTE_MS)), "minute");
  const days = localDaysBetween(at, now);
  if (days === 0) return ago(Math.max(1, Math.floor(elapsed / HOUR_MS)), "hour");
  // The one unit with a name of its own in most languages; Intl supplies it.
  if (days === 1) return ago(1, "day", "auto");
  if (days < DAYS_PER_WEEK) return ago(days, "day");
  if (days < DAYS_PER_MONTH) return ago(Math.floor(days / DAYS_PER_WEEK), "week");
  if (days < DAYS_PER_YEAR) return ago(Math.floor(days / DAYS_PER_MONTH), "month");
  return ago(1, "year");
}
