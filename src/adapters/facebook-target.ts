// SPDX-License-Identifier: GPL-3.0-or-later
//
// Facebook: given a post container and its action row, what is the target?
// The ordered resolution pipeline (reel viewer -> media viewer -> group story ->
// photo -> own permalink -> current photo -> feed reel -> page post -> CFT hash)
// plus everything it needs to mine an identity out of the DOM: the permalink and
// photo candidate collectors, the React-fiber href recovery for lazy date links,
// and the id-to-TargetRef builders.
//
// Depends on facebook-post-row.ts only for widenToPostUnit (the post-unit
// boundary a photo lookup may widen to).

import type { TargetRef } from "../shared/adapter";
import { canonicalPostIdForPhoto, photoIsAmbiguous, postUrlForPhoto } from "./facebook-photo-identity";
import { widenToPostUnit } from "./facebook-post-row";
import {
  canonicalizeFbUrl,
  currentPagePhotoUrl,
  currentPagePostUrl,
  currentPageReelUrl,
  currentPageWatchUrl,
  extractFbId,
  extractPhotoFbid,
  FB_NUMERIC_ID_RE,
  fbUrlFallbackId,
  groupStoryPermalinkFromPhotoUrl,
  hashUrl,
  isGroupStoryPermalink,
  isStandalonePhotoViewerPage,
  isStandaloneReelViewerPage,
  normalizeCftHref,
  normalizePhotoHref,
  normalizePostHref,
  pcbPostIdFromPhotoUrl,
} from "./facebook-urls";
import { ancestors, precedes, textOf } from "./runtime";

const TIMESTAMP_TEXT_STEM = /\b(?:just now|yesterday|today|\d+\s*(?:m|min|h|hr|d|w|mo|y)|\d{1,2}:\d{2})\b|сейчас|только что|вчера|сегодня|\d+\s*(?:мин|ч|дн|нед|мес|г)|січ|янв|фев|лют|мар|апр|кві|ма[йя]|июн|чер|июл|лип|авг|сер|сен|вер|окт|жов|ноя|лис|дек|гру/iu;

// Clicking a photo inside a group post opens the standalone viewer at a bare
// `/photo/?fbid=...&set=a.<album>` URL - no group marker - and the viewer's own
// panel shows the photo's CREATION story (the author's original post, with its
// own reaction counts), so neither the URL nor the viewer DOM can recover which
// group post the user came from. The click itself is the only context: record
// clicked photo -> the origin unit's group story permalink (module state
// survives the SPA transition into the viewer), and targetFromPhotoUrl keys the
// viewer on it. A direct URL open (new tab, cold load) has no click context and
// keeps the photo-entity key. Written by facebook.ts's photoClickContextCapture
// observer plugin, which owns the click listener that records the context.
export const clickedPhotoStoryUrls = new Map<string, string>();

// Hard ceiling with oldest-first eviction, like the other long-lived module maps
// (e.g. the placed-target set in ui/mount-session.ts - though that one is plain
// FIFO). Here re-inserting refreshes recency, because the viewer reads an entry
// right after its click: the freshest click must never be the one evicted.
const CLICKED_PHOTO_STORIES_MAX = 200;

export function recordClickedPhotoStory(photoId: string, storyUrl: string): void {
  clickedPhotoStoryUrls.delete(photoId);
  clickedPhotoStoryUrls.set(photoId, storyUrl);
  if (clickedPhotoStoryUrls.size <= CLICKED_PHOTO_STORIES_MAX) return;
  const oldest = clickedPhotoStoryUrls.keys().next().value;
  if (oldest !== undefined) clickedPhotoStoryUrls.delete(oldest);
}

interface ReactFiberLike {
  memoizedProps?: unknown;
  return?: ReactFiberLike | null;
}

// The date link's wrapper components sit within a handful of fiber `return`
// levels; staying shallow keeps us inside this post's link subtree.
const REACT_FIBER_WALK_DEPTH = 8;

// Resolve a link's canonical POST permalink from React internals. Facebook
// renders the post date link with a LAZY href - a `?__cft__` click-tracking
// placeholder that only swaps to the real `/posts/<id>` (or `/reel/`, `/videos/`)
// permalink on hover/focus, an anti-scraping deferral - so at scan time the DOM
// href is useless and posts collapsed onto the page URL / a volatile cft hash.
// The canonical URL is, however, already in the React tree: on the anchor's own
// last-rendered props OR (verified live) on a parent component a few levels up
// the fiber `return` chain. Gated to post-shaped URLs (normalizePostHref) so the
// placeholder or an unrelated link is never picked up. Completely passive: no
// events dispatched, so no Hovercard-preview loop risk.
function reactPostHref(el: Element): string | null {
  for (const raw of reactHrefCandidates(el)) {
    const url = normalizePostHref(raw);
    if (url) return url;
  }
  return null;
}

function reactHrefCandidates(el: Element): string[] {
  const out: string[] = [];
  const record = el as unknown as Record<string, unknown>;
  // Own keys only - `for...in` would walk the prototype chain and surface
  // inherited DOM properties. Listed once: this runs per permalink candidate.
  const keys = Object.getOwnPropertyNames(record);
  // The anchor's own last-rendered props.
  for (const key of keys) {
    if (!key.startsWith("__reactProps")) continue;
    const href = (record[key] as { href?: unknown } | null)?.href;
    if (typeof href === "string" && href.length > 0) out.push(href);
  }
  // Walk the fiber `return` chain; the canonical permalink lives in an
  // ancestor component's props even when the leaf href is the placeholder.
  const fiberKey = keys.find((name) => name.startsWith("__reactFiber"));
  let fiber = fiberKey ? (record[fiberKey] as ReactFiberLike | null) : null;
  for (let depth = 0; fiber && depth < REACT_FIBER_WALK_DEPTH; depth++) {
    const props = fiber.memoizedProps;
    if (props && typeof props === "object") {
      for (const key of ["href", "url", "uri", "to"] as const) {
        const href = (props as Record<string, unknown>)[key];
        if (typeof href === "string" && href.length > 0) out.push(href);
      }
    }
    fiber = fiber.return ?? null;
  }
  return out;
}

// Facebook defers a post's real permalink behind a TRUSTED hover: until one lands,
// the date link's href is a `?__cft__` placeholder - the fallback this recognizes.
function isLikelyLazyDateLink(link: HTMLAnchorElement, rawHref: string): boolean {
  if (looksLikeTimestampLink(link)) return true;
  // Facebook's lazy timestamp hrefs usually carry the post/permalink branch in
  // __tn__ (`P`). Used for passive CFT fallback target extraction.
  return /(?:^|[?&])__tn__=[^&]*%2CP/i.test(rawHref);
}

// A timestamp label is short in every shipped locale even at its most verbose
// ("Yesterday at 11:32 PM" plus an audience suffix); past this the text is a caption
// that merely mentions a time, so its link is not the post's date link.
const TIMESTAMP_TEXT_MAX = 96;

// Whether a link reads as a post timestamp, and so qualifies as a CFT fallback
// candidate for collectCftCandidates.
function looksLikeTimestampLink(link: HTMLAnchorElement): boolean {
  const text = [textOf(link), link.getAttribute("aria-label") ?? "", link.getAttribute("title") ?? ""].join(" ").trim();
  return text.length > 0 && text.length <= TIMESTAMP_TEXT_MAX && TIMESTAMP_TEXT_STEM.test(text);
}

// Standalone Reel viewer (`/reel/<id>`): the only permalink-shaped link is the
// `/reel/?s=tab` nav (which the generic scan would wrongly key on). Resolve the
// active reel from its player's data-video-id first (fall back to the page URL)
// so the picker keys on the same reel id the feed card does.
function resolveReelViewerTarget(article: HTMLElement, actionRow: HTMLElement | null): TargetRef | null {
  if (!isStandaloneReelViewerPage()) return null;
  const reel = findReelTargetNear(article, actionRow);
  if (reel) return reel;
  const reelUrl = currentPageReelUrl();
  return reelUrl ? targetFromPostUrl(reelUrl) : null;
}

// Standalone media-viewer pages (`/photo/?fbid=`, `/watch/?v=`) carry the
// canonical id in the page URL's query. The viewer's own action row sits in the
// photo panel / video `main`, NOT a feed `[role="article"]` - resolve from
// `location` FIRST: the DOM/React permalink scan latches onto the parent post's
// `/posts/` link or the video's `/reel/` permalink and drops the query,
// collapsing every photo onto a bare `.../photo/` and every video onto a reel URL.
function resolveMediaViewerTarget(article: HTMLElement): TargetRef | null {
  if (article.closest('[role="article"]')) return null;
  return currentPageViewerTarget();
}

// GROUP-FIRST: a group post's surface-stable identity is its story id - the
// id `set=gm.` photo links rebuild to and the post page URL carries. But a
// group post can also attach ALBUM photos (`set=a.`, no gm), and the post
// page renders the author's avatar as a `photo.php?set=p.` link nearest the
// action row - so the photo-first path keyed the feed on the album media and the
// post page on the AVATAR photo, splitting one post across targets (verified
// live). When the unit shows a group story permalink (comment/date timestamps
// hydrate eagerly), key on that story id before consulting photos; gm-set photos
// resolve to the same id, so their keys are unchanged. A unit without one
// (zero-comment card, lazy date link) keeps the photo/CFT fallback and upgrades
// on the user's hover like any lazy permalink.
function resolveGroupStoryTarget(article: HTMLElement, actionRow: HTMLElement | null): TargetRef | null {
  const groupStory = findGroupStoryPermalinkNear(article, actionRow);
  return groupStory ? targetFromPostUrl(groupStory) : null;
}

// PHOTO-FIRST: a photo post's attached media id is the one identity
// URL-derivable on EVERY surface (the photo-viewer `fbid` AND the feed/permalink
// card's `/photo/?fbid=` link), so keying on it converges the feed card, the
// permalink and the photo viewer - and it's read from the DOM (no JSON-mining
// timing), stable even on a streaming feed. A reshared (ambiguous) photo
// escalates to the per-post numeric id inside findPhotoTargetNear; text/video
// posts fall through to the permalink path. Skipped on the shared-photo
// re-resolution. Try the resolved container first (cheap on a feed card); only
// widen to the full post unit when no photo is found - on a permalink page
// findPostContainer resolves to the date-link wrapper, which sits below the
// photo and hides it. The lazy widen keeps the extra scan off the hot feed path.
function resolvePhotoTarget(article: HTMLElement, actionRow: HTMLElement | null, opts: { skipSharedPhoto?: boolean }): TargetRef | null {
  if (opts.skipSharedPhoto) return null;
  let mediaTarget = findPhotoTargetNear(article, actionRow);
  if (!mediaTarget && actionRow) {
    const wider = widenToPostUnit(actionRow, article);
    if (wider !== article) mediaTarget = findPhotoTargetNear(wider, actionRow);
  }
  return mediaTarget;
}

// The post's OWN permalink (date link) - for text/video posts or a photo post
// whose media wasn't usable. The page-URL fallback comes LATER so a secondary
// "Suggested for you" card without its own permalink doesn't inherit the page's
// main-post permalink.
function resolveOwnPermalinkTarget(article: HTMLElement, actionRow: HTMLElement | null): TargetRef | null {
  // findPermalinkNear ends in the same full-article sweep findPermalink does, so a
  // null from it leaves nothing for a second sweep to find.
  const ownPermalink = actionRow ? findPermalinkNear(article, actionRow) : findPermalink(article);
  return ownPermalink ? targetFromPostUrl(ownPermalink) : null;
}

// Standalone current-photo: the page URL's own photo, for a candidate on a photo
// page that resolved no permalink of its own.
function resolveCurrentPhotoTarget(opts: { skipSharedPhoto?: boolean }): TargetRef | null {
  if (opts.skipSharedPhoto) return null;
  const currentPhoto = currentPagePhotoUrl();
  return currentPhoto ? targetFromPhotoUrl(currentPhoto) : null;
}

// Last resort for a detail page's OWN post whose date link wasn't found and
// which carries no photo identity: the page URL itself.
function resolvePagePostTarget(): TargetRef | null {
  const pagePost = currentPagePostUrl();
  return pagePost ? targetFromPostUrl(pagePost) : null;
}

// Final fallback: a volatile `?__cft__` timestamp href, hashed under the `url:`
// sub-prefix (the hash changes per render, so it's the last resort).
function resolveCftFallbackTarget(article: HTMLElement, actionRow: HTMLElement | null): TargetRef | null {
  const url = findCftTargetUrlNear(article, actionRow);
  if (!url) return null;
  return { site: "facebook", targetId: `url:${hashUrl(url)}`, url };
}

// First non-null stage wins (order in resolveTargetStage below).
//
// Several stages resolve their `url` from a raw DOM href, which on Facebook carries
// per-render tracking blobs (`__cft__`, `fbclid`, `mibextid`). That url is submitted
// with the vote and stored in local history, so every stage's result is canonicalized
// here - one choke point instead of a rule each resolver has to remember. Target IDS
// are computed BEFORE this and stay untouched.
export function extractTarget(article: HTMLElement, actionRow: HTMLElement | null, opts: { skipSharedPhoto?: boolean } = {}): TargetRef | null {
  const target = resolveTargetStage(article, actionRow, opts);
  return target ? { ...target, url: canonicalizeFbUrl(target.url) } : null;
}

function resolveTargetStage(article: HTMLElement, actionRow: HTMLElement | null, opts: { skipSharedPhoto?: boolean }): TargetRef | null {
  return (
    resolveReelViewerTarget(article, actionRow) ??
    resolveMediaViewerTarget(article) ??
    resolveGroupStoryTarget(article, actionRow) ??
    resolvePhotoTarget(article, actionRow, opts) ??
    resolveOwnPermalinkTarget(article, actionRow) ??
    resolveCurrentPhotoTarget(opts) ??
    // Feed reel: a reel card's date link is a lazy `__cft__` placeholder and it
    // carries no `/reel/<id>` link. Key on the player's data-video-id (stable, ==
    // the reel viewer's id) instead of the volatile `url:<cft-hash>` fallback - that
    // hash changes per render, so the reaction "sometimes" didn't survive a reload.
    // Regular video posts have a real date-link permalink and never reach here.
    findReelTargetNear(article, actionRow) ??
    resolvePagePostTarget() ??
    resolveCftFallbackTarget(article, actionRow)
  );
}

function targetFromPostUrl(url: string): TargetRef {
  const id = extractFbId(url);
  if (!id) {
    return { site: "facebook", targetId: fbUrlFallbackId(url), url };
  }
  return { site: "facebook", targetId: id, url };
}

// A bare numeric post id (the canonical, surface-stable identity) - as opposed
// to a `pfbid...`, `photo:<media>`, or `url:<hash>` token.
function isCanonicalNumericId(targetId: string): boolean {
  return FB_NUMERIC_ID_RE.test(targetId);
}

// Build a TargetRef whose url and targetId stay derivation-compatible.
export function facebookTarget(targetId: string, sourceUrl: string): TargetRef {
  if (!isCanonicalNumericId(targetId) || extractFbId(sourceUrl) === targetId) {
    return { site: "facebook", targetId, url: sourceUrl };
  }
  const actor = actorIdOf(sourceUrl);
  const url = `https://www.facebook.com/permalink.php?story_fbid=${targetId}${actor ? `&id=${actor}` : ""}`;
  return { site: "facebook", targetId, url };
}

function actorIdOf(url: string): string | null {
  try {
    const id = new URL(url, location.href).searchParams.get("id");
    return id && /^\d{3,}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

export function targetFromPhotoUrl(url: string): TargetRef {
  const groupStory = groupStoryPermalinkFromPhotoUrl(url);
  if (groupStory) return targetFromPostUrl(groupStory);

  // A timeline multi-photo set names the post itself (`set=pcb.<postId>`), so
  // every photo of the post keys on the ONE post id - a per-photo `photo:<fbid>`
  // key here split one post into a target per photo (only the photo nearest the
  // action row matched the feed's reaction). Prefer the mined story permalink as
  // the human-facing url; facebookTarget rebuilds a derivable one otherwise.
  const pcbPostId = pcbPostIdFromPhotoUrl(url);
  if (pcbPostId) {
    const mediaId = extractPhotoFbid(url);
    return facebookTarget(pcbPostId, (mediaId ? postUrlForPhoto(mediaId) : null) ?? url);
  }

  const id = extractPhotoFbid(url);
  if (!id) return targetFromPostUrl(url);
  // Click-origin group story (photoClickContextCapture): the only signal tying
  // an album-set photo viewer back to the group post it was opened from. It
  // outranks the JSON ambiguity map - an explicit user navigation beats mined
  // page data. Gated to the standalone viewer page so a feed/timeline CARD of
  // the same media (a different surface with its own context) never inherits
  // the clicked group story.
  if (isStandalonePhotoViewerPage()) {
    const clickedStory = clickedPhotoStoryUrls.get(id);
    if (clickedStory) return targetFromPostUrl(clickedStory);
  }
  // Shared media can resolve to a post-specific id when page data proves it.
  if (photoIsAmbiguous(id)) {
    const canonical = canonicalPostIdForPhoto(id);
    if (canonical) {
      return facebookTarget(canonical, postUrlForPhoto(id) ?? `https://www.facebook.com/photo/?fbid=${id}`);
    }
    const postUrl = postUrlForPhoto(id);
    if (postUrl) return targetFromPostUrl(postUrl);
  }
  return {
    site: "facebook",
    targetId: `photo:${id}`,
    url: `https://www.facebook.com/photo/?fbid=${id}`,
  };
}

// Facebook renders the canonical permalink as the date link in the post header
// ("3h", "May 14 at 3:21 PM"). Selection is by postPermalinkRank (pfbid >
// numeric > embedded player); on a tie the LAST candidate in DOM order wins
// (nearest the row). The collector drops links from a nested (quoted) article
// and /videos/ | /reel/ links that WRAP media - a bare one still ranks. The
// visible date text is obfuscated into per-character <span>s (some CSS-hidden) -
// only the href is read, so that doesn't matter.
function findPermalink(article: HTMLElement): string | null {
  return bestPermalink(collectPermalinkCandidates(article));
}

function findPermalinkNear(container: HTMLElement, actionRow: HTMLElement): string | null {
  const candidates = collectPermalinkCandidates(container);
  // Prefer candidates before the action row (the post's own date link), then
  // fall back to all. `bestPermalink` picks by rank, so the SAME post resolves
  // to ONE stable permalink regardless of DOM order.
  const before = candidates.filter((c) => precedes(c.link, actionRow));
  return bestPermalink(before) ?? bestPermalink(candidates);
}

// Highest rank wins; on a tie keep the LAST candidate (nearest the row). See
// postPermalinkRank for the ordering.
function bestPermalink(candidates: Array<{ link: HTMLAnchorElement; url: string }>): string | null {
  let best: { url: string; rank: number } | null = null;
  for (const candidate of candidates) {
    const rank = postPermalinkRank(candidate.url);
    if (!best || rank >= best.rank) best = { url: candidate.url, rank };
  }
  return best?.url ?? null;
}

// Permalink preference, highest first:
//   3 - modern pfbid /posts/ | /permalink/ (the canonical date-link form)
//   2 - legacy numeric /posts/ | /permalink/
//   1 - embedded-media /videos/ | /reel/
// pfbid > numeric because FB exposes BOTH link forms for the SAME post, and a
// DOM-order tiebreak flipped the target key between re-renders (verified live:
// keys flipping `4271...`<->`pfbid...`, detaching the mounted host and leaving the
// post button-less until a fresh load). A deterministic key keeps the
// detached-host remount path working and stops double-keying one post. A pure
// video/reel post has no /posts/ link, so its date link still wins by default -
// only an embedded player loses.
function postPermalinkRank(url: string): number {
  if (/\/videos\/|\/reel\//.test(url)) return 1;
  return /pfbid[A-Za-z0-9]{20,}/.test(url) ? 3 : 2;
}

// Shared skeleton for the three candidate collectors: walk the container's
// anchors, keep only those belonging to this post container, run the per-type
// href mapper, and dedupe by the resulting url (first occurrence in DOM order
// wins). `mapHref` returns null to drop an anchor.
function collectAnchorTargets(container: HTMLElement, mapHref: (link: HTMLAnchorElement) => string | null): Array<{ link: HTMLAnchorElement; url: string }> {
  const out: Array<{ link: HTMLAnchorElement; url: string }> = [];
  const seen = new Set<string>();
  for (const link of container.querySelectorAll<HTMLAnchorElement>('a[href], a[role="link"]')) {
    if (!belongsToPostContainer(link, container)) continue;
    const url = mapHref(link);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ link, url });
  }
  return out;
}

function collectPermalinkCandidates(container: HTMLElement): Array<{ link: HTMLAnchorElement; url: string }> {
  return collectAnchorTargets(container, (link) => {
    // Skip embedded media players (a /videos/ or /reel/ link wrapping the
    // video/poster): those are the post's media, not its permalink - picking the
    // player link saved the wrong target on video posts.
    if (wrapsEmbeddedMedia(link)) return null;
    return normalizePostHref(link.getAttribute("href") || link.href) ?? reactPostHref(link);
  });
}

// A permalink link wrapping a media element is an embedded player, not the date
// link (which wraps timestamp text only).
function wrapsEmbeddedMedia(link: Element): boolean {
  return link.querySelector('img, image, video, canvas, [role="img"]') !== null;
}

// How far up from the action row to hunt for the reel player's data-video-id.
const REEL_PLAYER_WALK_DEPTH = 16;

// Resolve a reel from the nearest player id and pair it with a canonical URL.
function findReelTargetNear(container: HTMLElement, actionRow: HTMLElement | null): TargetRef | null {
  for (const node of ancestors(actionRow ?? container, REEL_PLAYER_WALK_DEPTH)) {
    const player = node.querySelector<HTMLElement>("[data-video-id]");
    const id = player?.getAttribute("data-video-id");
    if (id && FB_NUMERIC_ID_RE.test(id)) {
      return {
        site: "facebook",
        targetId: id,
        url: `https://www.facebook.com/reel/${id}`,
      };
    }
  }
  return null;
}

// The unit's own group story permalink, when one is hydrated in its DOM (the
// post date link on hover, comment timestamps eagerly). Nested-article links
// (shared/quoted posts) are already rejected by collectPermalinkCandidates.
export function findGroupStoryPermalinkNear(container: HTMLElement, actionRow: HTMLElement | null): string | null {
  const candidates = collectPermalinkCandidates(container).filter((c) => isGroupStoryPermalink(c.url));
  return nearestCandidate(candidates, actionRow)?.url ?? null;
}

function findPhotoTargetNear(container: HTMLElement, actionRow: HTMLElement | null): TargetRef | null {
  const candidate = nearestCandidate(collectPhotoCandidates(container), actionRow);
  if (!candidate) return null;
  const fbid = extractPhotoFbid(candidate.url);
  if (!fbid) return null;
  // A photo the page's embedded JSON ties to MORE THAN ONE story is a reshared
  // image, not a per-post identity. Escalate to the canonical numeric post id;
  // if it isn't mined, BAIL so extractTarget falls through to the per-post
  // date-link/CFT fallback and the two posts stay distinct. A group photo's
  // `set=gm.<storyId>` and a multi-photo `set=pcb.<postId>` are per-post, so not
  // ambiguous. (This null-bail is why the ambiguity is handled here rather than
  // in targetFromPhotoUrl, which always returns a key.)
  if (photoIsAmbiguous(fbid) && !groupStoryPermalinkFromPhotoUrl(candidate.url) && !pcbPostIdFromPhotoUrl(candidate.url)) {
    const canonical = canonicalPostIdForPhoto(fbid);
    if (canonical) {
      return facebookTarget(canonical, postUrlForPhoto(fbid) ?? candidate.url);
    }
    return null;
  }
  // Unambiguous: the media id IS the per-post key shared by every surface. Route
  // through targetFromPhotoUrl so the group `set=gm.` rebuild applies too; it
  // yields `photo:<media>` for an ordinary single photo.
  return targetFromPhotoUrl(candidate.url);
}

function collectPhotoCandidates(container: HTMLElement): Array<{ link: HTMLAnchorElement; url: string }> {
  return collectAnchorTargets(container, (link) => normalizePhotoHref(link.getAttribute("href") || link.href));
}

function findCftTargetUrlNear(container: HTMLElement, actionRow: HTMLElement | null): string | null {
  return nearestCandidate(collectCftCandidates(container), actionRow)?.url ?? null;
}

function collectCftCandidates(container: HTMLElement): Array<{ link: HTMLAnchorElement; url: string }> {
  return collectAnchorTargets(container, (link) => {
    const raw = link.getAttribute("href") || link.href;
    if (!isLikelyLazyDateLink(link, raw)) return null;
    return normalizeCftHref(raw);
  });
}

function nearestCandidate<T extends { link: HTMLAnchorElement }>(candidates: T[], actionRow: HTMLElement | null): T | null {
  if (!actionRow) return candidates[0] ?? null;
  let nearestBefore: T | null = null;
  for (const candidate of candidates) {
    if (precedes(candidate.link, actionRow)) nearestBefore = candidate;
  }
  return nearestBefore ?? candidates[0] ?? null;
}

// Canonical target for a standalone media-viewer page, derived from the page
// URL itself (the only place the id reliably lives, query string included).
function currentPageViewerTarget(): TargetRef | null {
  const photo = currentPagePhotoUrl();
  if (photo) return targetFromPhotoUrl(photo);
  const watch = currentPageWatchUrl();
  if (watch) return targetFromWatchUrl(watch);
  return null;
}

// A `/watch/?v=<id>` video, a `/reel/<id>`, and a feed video post's
// `/videos/<id>` date link are the same Facebook object - the numeric `v` is the
// id extractFbId pulls from the `/reel/`|`/videos/` forms. Keying watch on the
// bare numeric id (no `video:` namespace) converges all three surfaces on one
// target. Lockstep-safe: the bare numeric id is the canonical shape all three surfaces derive.
export function targetFromWatchUrl(url: string): TargetRef {
  const videoId = new URL(url).searchParams.get("v") ?? "";
  return {
    site: "facebook",
    targetId: videoId,
    url: `https://www.facebook.com/watch/?v=${videoId}`,
  };
}

function belongsToPostContainer(el: Element, container: HTMLElement): boolean {
  const owner = el.closest<HTMLElement>('[role="article"]');
  if (!owner) return true;
  if (owner === container) return true;
  if (!container.contains(owner)) return false;
  if (container.matches('[role="article"]')) return false;

  // Feed-unit wrappers can hold a top-level article for the post body while the
  // action row renders as a sibling. Allow that top-level child article, but
  // still reject quoted/shared articles nested inside it.
  const parentArticle = owner.parentElement?.closest<HTMLElement>('[role="article"]');
  return !parentArticle || !container.contains(parentArticle);
}
