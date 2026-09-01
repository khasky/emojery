// SPDX-License-Identifier: GPL-3.0-or-later
//
// Constrain a stored/derived URL to http(s) before it is used as an `<a href>`.
// The extension page's MV3 CSP already blocks `javascript:` navigation, but
// gating the scheme keeps any non-http URL (javascript:, data:, blob:, ...) from
// rendering as a clickable link at all - defense-in-depth against a CSP
// regression or a tainted target URL slipping into history.

export function safeHttpHref(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
