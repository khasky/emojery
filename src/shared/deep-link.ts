// SPDX-License-Identifier: GPL-3.0-or-later
//
// The /react deep-link contract shared between the emojery.app page and
// the extension. The emojery.app /react handler detects the extension via
// the presence beacon, then bounces to the real target URL with a `#emojery-react=<key>`
// hash; on the target site the extension reads that hash and auto-opens the
// reaction picker for the matching mount. Kept in lockstep BY HAND with that
// page - no cross-repo import.

// The dataset key the beacon content script stamps on <html>
// (document.documentElement.dataset.emojery = <version>), read by the page to
// confirm the extension is installed. Maps to the `data-emojery` attribute.
export const BEACON_DATASET_KEY = "emojery";

// The URL-hash marker (without the leading '#'): `emojery-react` opens the first
// mounted target on the page; `emojery-react=<encoded targetKey>` opens that
// specific target.
const HINT_PREFIX = "emojery-react";

// The name this hint shipped under first. Still parsed, never emitted: links
// already shared carry it, and so does any emojery.app deploy older than the
// rename. Drop it only once those links can no longer reach a user.
const LEGACY_HINT_PREFIX = "em-react";

export interface ReactHint {
  // The `site:targetId` mount key to open, or null to open the first target.
  targetKey: string | null;
}

// Parse a location hash into a react hint, or null if it isn't one. Accepts the
// leading '#'. The keyed form carries a percent-encoded `site:targetId`.
export function parseReactHint(hash: string): ReactHint | null {
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const prefix of [HINT_PREFIX, LEGACY_HINT_PREFIX]) {
    if (raw === prefix) return { targetKey: null };
    const eq = `${prefix}=`;
    if (!raw.startsWith(eq)) continue;
    const rest = raw.slice(eq.length);
    let key: string;
    try {
      key = decodeURIComponent(rest);
    } catch {
      key = rest;
    }
    return { targetKey: key || null };
  }
  return null;
}

// The documented emit half of the deep-link contract: the emojery.app /react
// page builds this exact hash (mirrored by hand, per the header note). Nothing
// in this repo calls it; it lives here so the format has one definition and
// one test pinning it.
export function buildReactHint(targetKey: string | null): string {
  return targetKey ? `#${HINT_PREFIX}=${encodeURIComponent(targetKey)}` : `#${HINT_PREFIX}`;
}
