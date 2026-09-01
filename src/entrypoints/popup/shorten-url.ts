// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pure helper, kept out of the JSX module so it is unit-testable;
// popup-shared.tsx re-exports it to the app.

export function shortenUrl(url: string): string {
  // Drop the protocol and the fragment; everything that distinguishes a target (a Facebook
  // photo's `?fbid=...`) is kept. Width truncation is CSS's job (ellipsis), so return the
  // full string and let it clip; the tooltip still carries the complete URL.
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}
