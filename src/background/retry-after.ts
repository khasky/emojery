// SPDX-License-Identifier: GPL-3.0-or-later

/** Parse `Retry-After` as delta-seconds or HTTP-date. */
export function parseRetryAfterSeconds(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.floor((date - Date.now()) / 1000));
  }
  return undefined;
}
