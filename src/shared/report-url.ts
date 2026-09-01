// SPDX-License-Identifier: GPL-3.0-or-later
import type { SupportedSite } from "./adapter";

// Query params that IDENTIFY the reported content on sites that carry the id
// in the query rather than the path (YouTube `watch?v=`, Facebook `?fbid=` /
// `?story_fbid=&id=`). Everything else is dropped so a report URL can't carry
// session tokens, search terms, or in-page state.
const IDENTITY_QUERY_PARAMS: Partial<Record<SupportedSite, readonly string[]>> = {
  youtube: ["v"],
  facebook: ["v", "fbid", "set", "idorvanity", "story_fbid", "id"],
};

/** The page URL a problem report shows and submits: origin + path, plus only
 *  the site's identity-bearing query params - without them a YouTube report
 *  pointed at a bare `/watch` with no video id. */
export function reportPageUrl(pageUrl: URL, site: SupportedSite): string {
  const kept = new URLSearchParams();
  for (const name of IDENTITY_QUERY_PARAMS[site] ?? []) {
    const value = pageUrl.searchParams.get(name);
    if (value !== null) kept.set(name, value);
  }
  const query = kept.toString();
  return `${pageUrl.origin}${pageUrl.pathname}${query ? `?${query}` : ""}`;
}
