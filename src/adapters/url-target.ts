// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared URL->target plumbing. `parseSiteHref` wraps a site's own regex in the
// scaffolding every URL parser repeats, so each adapter keeps a directly testable
// `extract...Ref` and nothing more; `urlTargetResolver` adds the location-only
// `resolveTarget` on top, for the page-level sites. A site with per-link logic
// (X's quoted-tweet exclusion, the focused-status gate) keeps its own.
import type { SupportedSite, TargetRef } from "../shared/adapter";
import { urlHostBelongsToSite } from "../shared/sites";

/** `parse` keeps only the site-specific regex/canonicalization: the null bail,
 *  resolution against the page location, the parse-host gate and a malformed URL
 *  are all handled here. */
export function parseSiteHref<Ref>(href: string | null, site: SupportedSite, parse: (url: URL) => Ref | null): Ref | null {
  if (!href) return null;
  try {
    const url = new URL(href, location.href);
    return urlHostBelongsToSite(url.hostname, site) ? parse(url) : null;
  } catch {
    return null;
  }
}

/** Non-empty, trimmed path segments of a pathname ("/a/b/" -> ["a","b"]) - the
 *  shared primitive for the path-based target parsers. */
export function pathSegments(pathname: string): string[] {
  return pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/** A `resolveTarget` that reads `location.href` alone. Takes no candidate, so it
 *  drops straight into `SiteAdapterSpec.resolveTarget`, which passes arguments
 *  this ignores. */
export function urlTargetResolver<Ref>(opts: { parse: (href: string) => Ref | null; toTarget: (ref: Ref) => TargetRef }): () => TargetRef | null {
  return () => {
    const ref = typeof location !== "undefined" && location.href ? opts.parse(location.href) : null;
    return ref ? opts.toTarget(ref) : null;
  };
}
