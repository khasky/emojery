// SPDX-License-Identifier: GPL-3.0-or-later
//
// Facebook post identity. One post is reachable through several URLs whose ids
// live in UNRELATED namespaces - `/photo/?fbid=<mediaId>`, `/<actor>/posts/pfbid...`,
// `permalink.php?story_fbid=pfbid...` - and, verified live, the SAME post is served
// with DIFFERENT pfbids on different surfaces. The only identity stable across
// every surface is the post's NUMERIC `post_id`; the picker must key on that or
// it splits one post into several targets.
//
// Two maps, both mined from the page's own embedded
// `<script type="application/json">` blocks (a pure DOM read, not network interception):
//   - postIdMap - `media:<photoId>` -> canonical numeric post id. A second,
//     conflicting post id for one media id marks it ambiguous (null) so distinct
//     posts never merge.
//   - photoStoryMap - `media -> story permalink URL`, for a photo target's
//     human-facing `url` (and permalink fallback). Same ambiguity rule.
// Two JSON shapes feed them: the feed/SSR story node (`wwwURL`/`post_id` beside
// `attachments[].media`) and the standalone photo viewer's Photo node pointing
// back via `creation_story`/`container_story` (no `attachments`). Folded in
// lazily by ensureScriptPhotoMap; the maps accumulate, never wiped. Posts whose
// JSON arrives only over the wire are covered by the React-fiber walk in
// facebook-target.ts (reactPostHref / reactHrefCandidates).
import { extractFbId, FB_NUMERIC_ID_RE, normalizePostHref } from "./facebook-urls";

const photoStoryMap = new Map<string, string | null>();
const postIdMap = new Map<string, string | null>();
const parsedDataScripts = new WeakSet<Element>();

// Both maps gain an entry per distinct media id the page's embedded JSON names,
// and a feed session is unbounded - so, like the other long-lived id caches
// (ui/mount-registry.ts, background/api-read.ts), they carry a hard ceiling,
// sized for this cache alone. Well above one session's working set: a feed
// streams a few media ids per post.
const IDENTITY_MAP_MAX_ENTRIES = 5_000;

// At the cap, stop learning NEW ids but keep updating known ones. Deliberately
// not oldest-first eviction: an entry can be the `null` that marks a reshared
// photo AMBIGUOUS, and dropping that would let two distinct posts merge onto one
// `photo:<media>` key - the exact split this module exists to prevent. An id that
// is never recorded behaves like one whose JSON was never on the page, which is
// the ordinary, already-handled path (the caller falls back to the post's own
// permalink / CFT id).
function recordCapped<V>(map: Map<string, V>, key: string, value: V): void {
  if (!map.has(key) && map.size >= IDENTITY_MAP_MAX_ENTRIES) return;
  map.set(key, value);
}

export function postUrlForPhoto(photoId: string): string | null {
  ensureScriptPhotoMap();
  return photoStoryMap.get(photoId) ?? null;
}

// True once a photo is tied to more than one story (see recordPhotoStory).
export function photoIsAmbiguous(photoId: string): boolean {
  ensureScriptPhotoMap();
  return photoStoryMap.get(photoId) === null;
}

// Canonical numeric post id for a photo media id. Null when unknown or ambiguous
// (a reshared image tied to more than one post), so the caller falls back.
export function canonicalPostIdForPhoto(photoId: string): string | null {
  ensureScriptPhotoMap();
  return postIdMap.get(`media:${photoId}`) ?? null;
}

// Fold any not-yet-parsed embedded data scripts into the maps; the WeakSet keeps
// each script parsed exactly once as the feed streams new ones in.
function ensureScriptPhotoMap(): void {
  const scripts = document.querySelectorAll<HTMLScriptElement>('script[type="application/json"]');
  for (const script of scripts) {
    if (parsedDataScripts.has(script)) continue;
    parsedDataScripts.add(script);
    mergeIdentityJsonText(script.textContent || "");
  }
}

// Facebook streams some payloads as several newline-delimited JSON objects, so
// fall back to line-by-line parsing when the whole text isn't valid JSON on its
// own. Gated on identity tokens so unrelated blocks are skipped without a parse.
// The pure seam: unit tests feed captured JSON text here and never construct
// the page's script tags (that scan is e2e-covered).
export function mergeIdentityJsonText(text: string): void {
  if (text.indexOf("pfbid") < 0 && text.indexOf("Uzpf") < 0 && text.indexOf("post_id") < 0) {
    return;
  }
  for (const chunk of parseJsonChunks(text)) {
    collectIdentities(chunk);
  }
}

function parseJsonChunks(text: string): unknown[] {
  try {
    return [JSON.parse(text)];
  } catch {
    /* multipart @defer stream - parse each line below */
  }
  const out: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {}
  }
  return out;
}

const STORY_PERMALINK_RE = /\/(?:posts|permalink)\/(?:pfbid[A-Za-z0-9]+|\d+)|story_fbid=/;

// Runaway guards for the two JSON walks below - Facebook's bootstrap payload is
// machine-generated and unbounded in shape. All four are CEILINGS, not budgets to
// spend: the nodes carrying an identity sit far shallower. The attachment pair is
// much tighter because that walk starts at one story's `attachments`, not the root.
const WALK_NODE_BUDGET = 200_000;
const WALK_MAX_DEPTH = 45;
const ATTACHMENT_WALK_NODE_BUDGET = 4_000;
const ATTACHMENT_WALK_MAX_DEPTH = 8;

// Walk the JSON populating both maps from the two verified-live shapes: a story
// node (`wwwURL`/`url` permalink + `post_id` beside `attachments[].media`) and a
// Photo node naming its post via `creation_story`/`container_story`.
function collectIdentities(root: unknown): void {
  let budget = WALK_NODE_BUDGET;
  const visit = (input: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > WALK_MAX_DEPTH || !input || typeof input !== "object") return;
    const node = input as Record<string, unknown>;
    const pid = postIdFromNode(node);

    const storyUrl = storyPermalinkOf(node);
    if (storyUrl) {
      for (const mediaId of photoIdsIn(node.attachments)) {
        recordPhotoStory(mediaId, storyUrl);
        if (pid) recordNumeric(`media:${mediaId}`, pid);
      }
    }

    // Photo-viewer shape: a media node naming its post through its story child.
    const ownId = node.id;
    if (typeof ownId === "string" && FB_NUMERIC_ID_RE.test(ownId)) {
      for (const key of ["creation_story", "container_story"] as const) {
        const child = node[key];
        if (!child || typeof child !== "object") continue;
        const childNode = child as Record<string, unknown>;
        const childUrl = storyPermalinkOf(childNode);
        const childPid = postIdFromNode(childNode);
        if (childUrl) recordPhotoStory(ownId, childUrl);
        if (childPid) recordNumeric(`media:${ownId}`, childPid);
      }
    }

    for (const key in node) {
      const value = node[key];
      if (value && typeof value === "object") visit(value, depth + 1);
    }
  };
  visit(root, 0);
}

// Numeric post id a node carries: the explicit `post_id`/`legacy_story_hideable_id`
// field first, else decoded from an `UzpfST...` story node id.
function postIdFromNode(node: Record<string, unknown>): string | null {
  for (const key of ["post_id", "legacy_story_hideable_id"] as const) {
    const value = node[key];
    if (typeof value === "string" && FB_NUMERIC_ID_RE.test(value)) return value;
  }
  const id = node.id;
  return typeof id === "string" ? decodeEncodedStoryId(id) : null;
}

// Story node ids are base64 of `S:_I<actor>:<postId>:<postId>` - return the
// trailing numeric segment. Null for any other id shape (feedback ids, comment
// ids, opaque cursors, ...).
function decodeEncodedStoryId(id: string): string | null {
  if (!id.startsWith("Uzpf")) return null;
  let decoded: string;
  try {
    decoded = atob(id);
  } catch {
    return null;
  }
  if (!decoded.startsWith("S:_")) return null;
  const numeric = decoded.split(":").filter((part) => FB_NUMERIC_ID_RE.test(part));
  return numeric.length > 0 ? (numeric[numeric.length - 1] ?? null) : null;
}

// The header's ambiguity rule for postIdMap: a second, DIFFERENT post id nulls the entry.
function recordNumeric(key: string, pid: string): void {
  const prev = postIdMap.get(key);
  if (prev === undefined) recordCapped(postIdMap, key, pid);
  else if (prev !== pid) postIdMap.set(key, null);
}

// Marks a photo ambiguous (null) only on a genuinely DIFFERENT story: comparison
// is by story id, not raw URL, so one post seen through different url params
// (attachment `wwwURL` vs `creation_story` url, +/- `comment_id`) is not mistaken
// for two posts. A truly reshared image (two distinct stories) still nulls out.
function recordPhotoStory(photoId: string, storyUrl: string): void {
  const prev = photoStoryMap.get(photoId);
  if (prev === undefined) {
    recordCapped(photoStoryMap, photoId, storyUrl);
    return;
  }
  if (prev === null) return;
  if (extractFbId(prev) !== extractFbId(storyUrl)) photoStoryMap.set(photoId, null);
}

function storyPermalinkOf(node: Record<string, unknown>): string | null {
  for (const key of ["wwwURL", "url"] as const) {
    const value = node[key];
    if (typeof value === "string" && STORY_PERMALINK_RE.test(value)) {
      // STORY_PERMALINK_RE matches by path shape and would also match an off-host
      // URL embedded in the page's JSON; normalizePostHref enforces the host gate.
      // No `?? value` fallback - a value failing the gate is dropped, and a
      // genuine FB permalink always passes.
      return normalizePostHref(value);
    }
  }
  return null;
}

function photoIdsIn(attachments: unknown): string[] {
  const out: string[] = [];
  let budget = ATTACHMENT_WALK_NODE_BUDGET;
  const visit = (input: unknown, depth: number): void => {
    if (budget-- <= 0 || depth > ATTACHMENT_WALK_MAX_DEPTH || !input || typeof input !== "object") return;
    const node = input as Record<string, unknown>;
    if (node.__typename === "Photo" && typeof node.id === "string" && FB_NUMERIC_ID_RE.test(node.id)) {
      out.push(node.id);
    }
    for (const key in node) {
      const value = node[key];
      if (value && typeof value === "object") visit(value, depth + 1);
    }
  };
  visit(attachments, 0);
  return out;
}
