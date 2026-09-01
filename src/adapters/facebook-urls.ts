// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pure URL parse / normalize / canonicalize helpers for the Facebook adapter.
// No DOM element access (only `location` + the pure site registry), so this is a
// near-leaf the rest of the adapter builds on.
import { urlHostBelongsToSite } from "../shared/sites";

const POST_URL_RE = /\/posts\/|\/permalink\/|story_fbid=|\/videos\/|\/reel\/|\/story\.php\b/;
// Facebook's numeric ids - a photo `fbid`, a watch `v`, a reel id - are all bare
// 6+ digit runs.
export const FB_NUMERIC_ID_RE = /^\d{6,}$/;

// Parse-hosts (superset of the run-hosts www/m.facebook.com: bare `facebook.com`
// appears in DOM links the extension doesn't itself run on) - centralized in the
// registry's `urlHosts`. See sites.ts urlHostBelongsToSite.
export function isFacebookHost(host: string): boolean {
  return urlHostBelongsToSite(host, "facebook");
}

export function currentPagePostUrl(): string | null {
  return normalizePostHref(location.href);
}

export function currentPagePhotoUrl(): string | null {
  return normalizePhotoHref(location.href);
}

export function currentPageWatchUrl(): string | null {
  return normalizeWatchHref(location.href);
}

// The standalone Reel viewer (`/reel/<id>`) is a vertical-feed video page that
// ships no post permalink in the DOM (only a `/reel/?s=tab` nav link) - so the
// reel id must come from the page URL (or, per-reel, the player's data-video-id).
export function currentPageReelUrl(): string | null {
  try {
    const url = new URL(location.href);
    if (!isFacebookHost(url.hostname)) return null;
    const reelMatch = url.pathname.match(/^\/reel\/(\d{6,})\/?$/);
    return reelMatch ? `https://www.facebook.com/reel/${reelMatch[1]}` : null;
  } catch {
    return null;
  }
}

export function isStandalonePhotoViewerPage(): boolean {
  return currentPagePhotoUrl() !== null;
}

export function isStandaloneReelViewerPage(): boolean {
  return currentPageReelUrl() !== null;
}

function normalizeWatchHref(href: string): string | null {
  try {
    const url = new URL(href, location.href);
    if (!isFacebookHost(url.hostname)) return null;
    if (url.pathname !== "/watch" && url.pathname !== "/watch/") return null;
    const videoId = url.searchParams.get("v");
    if (!videoId || !FB_NUMERIC_ID_RE.test(videoId)) return null;
    return `https://www.facebook.com/watch/?v=${videoId}`;
  } catch {
    return null;
  }
}

export function normalizePostHref(href: string): string | null {
  if (!POST_URL_RE.test(href)) return null;
  try {
    const url = new URL(href, location.href);
    // Host-gate page-sourced hrefs before using them as target URLs.
    if (!isFacebookHost(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function normalizePhotoHref(href: string): string | null {
  try {
    const url = new URL(href, location.href);
    if (!isFacebookHost(url.hostname)) return null;
    if (url.pathname !== "/photo" && url.pathname !== "/photo/" && url.pathname !== "/photo.php") {
      return null;
    }
    const fbid = url.searchParams.get("fbid");
    if (!fbid || !FB_NUMERIC_ID_RE.test(fbid)) return null;
    // Preserve the identity-bearing sets so targetFromPhotoUrl can key the post
    // on its per-post id instead of the per-photo media id: a group set
    // (`set=gm.<storyId>` + its group) and a timeline multi-photo set
    // (`set=pcb.<postId>`). Everything else (albums, tracking params) is dropped
    // so the photo URL stays a stable de-dupe key.
    const set = url.searchParams.get("set");
    const group = url.searchParams.get("idorvanity");
    let identitySet = "";
    if (set && /^gm\.\d{6,}$/.test(set) && group) identitySet = `&set=${set}&idorvanity=${encodeURIComponent(group)}`;
    else if (set && /^pcb\.\d{6,}$/.test(set)) identitySet = `&set=${set}`;
    return `https://www.facebook.com/photo/?fbid=${fbid}${identitySet}`;
  } catch {
    return null;
  }
}

// A group photo URL carries the post's group-story id in `set=gm.<storyId>` -
// the SAME id the group permalink (`/groups/<g>/posts/<storyId>`) and the group
// feed's date link resolve to (verified live), and unique per post. Rebuild that
// permalink so the photo view keys on the story id, not the shared `photo:<media>`.
// Returns null for non-group photos (timeline `set=pcb.`/`a.`) and malformed URLs.
export function groupStoryPermalinkFromPhotoUrl(url: string): string | null {
  try {
    const parsed = new URL(url, location.href);
    const set = parsed.searchParams.get("set");
    const group = parsed.searchParams.get("idorvanity");
    const storyMatch = set?.match(/^gm\.(\d{6,})$/);
    if (!storyMatch?.[1] || !group) return null;
    return `https://www.facebook.com/groups/${encodeURIComponent(group)}/posts/${storyMatch[1]}/`;
  } catch {
    return null;
  }
}

// A group post's story permalink (`/groups/<g>/posts|permalink/<storyId>`,
// numeric - group stories don't use pfbid slugs): the per-post id every group
// surface shares. `set=gm.` photo links rebuild to it and the group post page
// URL carries it.
export function isGroupStoryPermalink(url: string): boolean {
  return /\/groups\/[^/]+\/(?:posts|permalink)\/\d{6,}/.test(url);
}

// A timeline multi-photo post URL carries the POST's own numeric id in
// `set=pcb.<postId>` - identical for every photo of the post and equal to the
// post's permalink id, while each photo's `fbid` differs per photo. Keying on it
// converges the feed card and every per-photo viewer of one multi-photo post on
// ONE target instead of splitting per photo (verified live: two photos of one
// page post opened as `?fbid=A&set=pcb.P` / `?fbid=B&set=pcb.P`). Null for
// single-photo/album (`a.`) and group (`gm.`) sets.
export function pcbPostIdFromPhotoUrl(url: string): string | null {
  try {
    const set = new URL(url, location.href).searchParams.get("set");
    const postIdMatch = set?.match(/^pcb\.(\d{6,})$/);
    return postIdMatch?.[1] ?? null;
  } catch {
    return null;
  }
}

export function extractPhotoFbid(url: string): string | null {
  try {
    const parsed = new URL(url);
    const fbid = parsed.searchParams.get("fbid");
    return fbid && FB_NUMERIC_ID_RE.test(fbid) ? fbid : null;
  } catch {
    return null;
  }
}

export function normalizeCftHref(href: string): string | null {
  try {
    const url = new URL(href, location.href);
    if (!isFacebookHost(url.hostname)) return null;
    const cft = url.searchParams.get("__cft__[0]");
    if (!cft) return null;
    return `https://www.facebook.com${location.pathname}?__cft__[0]=${encodeURIComponent(cft)}`;
  } catch {
    return null;
  }
}

// Two ID shapes Facebook serves today:
//   /<page>/posts/pfbid0XYZ...   - modern, base58-ish, ~60 chars after "pfbid"
//   /<page>/posts/1234567890     - legacy numeric
// `permalink`, `videos` and `reel` use the same two shapes; `?story_fbid=` is the
// rare legacy query-string form. The bare `?fbid=` query is a photo-viewer link,
// not a post, so it is intentionally not read here.
export function extractFbId(href: string): string | null {
  try {
    const parsed = new URL(href);
    const story = parsed.searchParams.get("story_fbid");
    if (story && /^(?:pfbid[A-Za-z0-9]{20,}|\d+)$/.test(story)) return story;
    const permalinkMatch = parsed.pathname.match(/\/(?:posts|permalink|videos|reel)\/(pfbid[A-Za-z0-9]{20,}|\d{6,})/);
    if (permalinkMatch) return permalinkMatch[1] ?? null;
  } catch {}
  return null;
}

// Four decorrelated 32-bit FNV-1a lanes (distinct seed AND multiplier each,
// murmur3's fmix32 avalanche on the way out) concatenated as base36 - ~128 bits
// of output. Width is the point: the previous single 32-bit lane put the
// birthday bound at ~77k keys, and `url:<hash>` is a GLOBAL identity shared by
// every user, so two unrelated Facebook posts merged their public reaction
// counts well inside one site's tail (measured: a collision after 38,489
// distinct permalinks). Deliberately not cryptographic - `resolveTarget` is
// synchronous so Web Crypto is out, and only ACCIDENTAL collisions are in
// scope here.
const HASH_LANES = [
  { seed: 0x811c9dc5, mul: 0x01000193 },
  { seed: 0x9e3779b9, mul: 0x85ebca77 },
  { seed: 0x7feb352d, mul: 0xc2b2ae35 },
  { seed: 0x2545f491, mul: 0x27d4eb2f },
] as const;

// murmur3 fmix32 - FNV-1a's low bits avalanche poorly on their own, and the
// base36 encoding below reads from exactly there.
function fmix32(h: number): number {
  let x = h;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b);
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35);
  return (x ^ (x >>> 16)) >>> 0;
}

export function hashUrl(url: string): string {
  const lanes: number[] = HASH_LANES.map((lane) => lane.seed);
  for (let i = 0; i < url.length; i++) {
    const code = url.charCodeAt(i);
    for (let laneIndex = 0; laneIndex < lanes.length; laneIndex++) {
      lanes[laneIndex] = Math.imul(lanes[laneIndex]! ^ code, HASH_LANES[laneIndex]!.mul);
    }
  }
  // Fixed 7 chars per lane (2^32-1 is "1z141z3"), so the id is a constant
  // 28 chars and two lanes can never blur into one another.
  return lanes.map((lane) => fmix32(lane).toString(36).padStart(7, "0")).join("");
}

// The only query params that carry post/page/video identity on a permalink;
// everything else (fbclid, mibextid, ref*, __tn__, __cft__, comment_id, ...) is
// tracking/render noise that must not change the target key.
const FB_KEEP_PARAMS = new Set(["story_fbid", "fbid", "id", "v"]);

// Canonicalize a permalink: force the www host, drop the fragment, keep only
// identity-bearing query params (sorted). Two callers, both required:
// `fbUrlFallbackId` (so variant URLs of one permalink hash to one key) and the
// adapter's `extractTarget`, which runs every resolved target's `url` through it
// so a raw href's tracking blobs (`__cft__`, `fbclid`) never reach the vote
// request or the local history. The `url:<hash>` disambiguator still hashes the
// RAW href, so two reshares of one image stay distinct.
export function canonicalizeFbUrl(raw: string): string {
  try {
    const parsed = new URL(raw, location.href);
    const kept: Array<[string, string]> = [];
    for (const [key, value] of parsed.searchParams) {
      if (FB_KEEP_PARAMS.has(key)) kept.push([key, value]);
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const query = kept.map(([key, value]) => `${key}=${value}`).join("&");
    return `https://www.facebook.com${parsed.pathname}${query ? `?${query}` : ""}`;
  } catch {
    return raw;
  }
}

// The stable `url:<hash>` id for a permalink that has no structured post id -
// variant URLs of the same permalink collapse to one key.
export function fbUrlFallbackId(url: string): string {
  return `url:${hashUrl(canonicalizeFbUrl(url))}`;
}
