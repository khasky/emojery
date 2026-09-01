// SPDX-License-Identifier: GPL-3.0-or-later
//
// The URL->target-id derivation as a pure function, for the sites whose id is
// URL-derivable. Every row pairs the adapter's OWN exported parser with its OWN
// `<site>TargetFromRef` (the ref->target half of the wire contract) - the two
// functions the shipped scan runs - so this can
// be exercised without a page while staying incapable of drifting from what a
// real page emits.
//
// Test-only: nothing in the shipped bundle imports this, and a drift between the
// switch/host-gating here and the adapters fails lockstep.test.ts.
//
// GitLab and Facebook are absent by design: their canonical id depends on page
// state beyond the URL (GitLab's numeric project id, Facebook's DOM-resolved
// photo/lazy-permalink identity), so it cannot be derived from the URL alone.
import type { TargetRef } from "../shared/adapter";
import { detectSupportedSite } from "../shared/sites";
import { amazonTargetFromAsin, asinFromPathname } from "./amazon";
import { githubTargetFromRef, repoRefFromHref } from "./github";
import { extractInstagramShortcode, instagramTargetFromRef } from "./instagram";
import { extractRedditPostRef, redditTargetFromRef } from "./reddit";
import { extractThreadsPostRef, threadsTargetFromRef } from "./threads";
import { extractXStatusRef, xTargetFromRef } from "./x";
import { extractYouTubeVideoRef, youtubeTargetFromRef } from "./youtube";

interface DerivedTarget {
  targetId: string;
  /** A canonical URL that re-derives to the same id. Regional hosts (Amazon) store
   *  their own host; only the id is contractual. */
  url: string;
}

export const URL_DERIVABLE_SITES = ["x", "youtube", "reddit", "instagram", "threads", "github", "amazon"] as const;

function derived(target: TargetRef | null): DerivedTarget | null {
  return target ? { targetId: target.targetId, url: target.url } : null;
}

// Amazon's id parser takes a PATHNAME, so it never sees the URL's authority -
// without this gate `https://evil.example/dp/<asin>` would derive a live
// product key. Gated with the run-host contract (`detectSupportedSite`) rather
// than the parse-host list, so the regional storefronts Amazon's `hostRegex`
// covers (amazon.nl, amazon.com.tr) still derive. Every other site here parses
// an href through `parseSiteHref`, which host-gates already.
function amazonPathname(url: string): string | null {
  try {
    const parsed = new URL(url);
    return detectSupportedSite(parsed.hostname) === "amazon" ? parsed.pathname : null;
  } catch {
    return null;
  }
}

export function deriveTargetFromUrl(site: string, url: string): DerivedTarget | null {
  switch (site) {
    case "x": {
      const ref = extractXStatusRef(url);
      return derived(ref && xTargetFromRef(ref));
    }
    case "youtube": {
      const ref = extractYouTubeVideoRef(url);
      return derived(ref && youtubeTargetFromRef(ref));
    }
    case "reddit": {
      const ref = extractRedditPostRef(url);
      return derived(ref && redditTargetFromRef(ref));
    }
    case "instagram": {
      // The adapter keys on the BARE shortcode (instagram.ts extractTarget), so
      // a post and its reel viewer converge; the canonical URL keeps the kind.
      const ref = extractInstagramShortcode(url);
      return derived(ref && instagramTargetFromRef(ref));
    }
    case "threads": {
      const ref = extractThreadsPostRef(url);
      return derived(ref && threadsTargetFromRef(ref));
    }
    case "github": {
      const ref = repoRefFromHref(url);
      return derived(ref && githubTargetFromRef(ref));
    }
    case "amazon": {
      const path = amazonPathname(url);
      const asin = path ? asinFromPathname(path) : null;
      // The canonical .com host, not the URL's own: only the id is contractual.
      return derived(asin ? amazonTargetFromAsin(asin, "www.amazon.com") : null);
    }
    default:
      return null;
  }
}
