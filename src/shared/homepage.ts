// SPDX-License-Identifier: GPL-3.0-or-later
//
// Single source of truth for the extension's own homepage host. The popup reads it
// through `isOwnHomepage` (below); the match pattern is what wxt.config.ts puts in the
// manifest host permission, and what shared/content-matches.test.ts pins
// entrypoints/emojery.content.ts's hand-written `matches` literal against (WXT extracts
// that literal statically, so the entrypoint can't compute it).
//
// The host is in host_permissions, so the tab URL is readable here (it's redacted
// on pages the extension holds no permission for).
const HOMEPAGE_HOST = "emojery.app";

export const HOMEPAGE_MATCH_PATTERN = `https://${HOMEPAGE_HOST}/*`;

export function isOwnHomepage(url: string | undefined): boolean {
  if (!url) return false;
  try {
    return new URL(url).hostname === HOMEPAGE_HOST;
  } catch {
    return false;
  }
}
