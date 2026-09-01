// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryAll, queryAllDeep } from "../shared/dom-query";
import { type Binding, defineSiteAdapter, type ScanContext } from "./framework";
import { shadowRootDiscovery } from "./observer-plugins";
import { safeMatches } from "./runtime";
import { parseSiteHref } from "./url-target";
import { hasRenderableBox } from "./visual-action-row";

// Attribute changes that can mean a post identity or slot moved.
const SHADOW_ATTRIBUTE_FILTER = ["id", "post-id", "thing-id", "permalink", "content-href", "slot"];

const POST_SELECTORS = ['shreddit-post[id^="t3_"]', 'shreddit-post[permalink*="/comments/"]', 'shreddit-post[permalink*="/gallery/"]', 'shreddit-post[content-href*="/comments/"]', 'shreddit-post[content-href*="/gallery/"]'];
const ACTION_BAR_SELECTORS = ['rpl-action-bar[post-id^="t3_"]'];
const VOTE_SELECTORS = ['shreddit-vote-animations[thing-id^="t3_"]'];
const FALLBACK_ACTION_SELECTORS = [
  'faceplate-dropdown-menu[slot="ssr-share-button"]',
  '[slot="ssr-share-button"] button[aria-label="Share"]',
  'button[aria-label="Share"]',
  'h1[id^="post-title-"]',
  '[slot="title"]',
  '[data-post-click-location="text-body"]',
  'shreddit-post[id^="t3_"]',
  'shreddit-post[permalink*="/comments/"]',
];
const POST_LINK_SELECTORS = ['a[href*="/comments/"]'];
const REDDIT_THING_RE = /^t3_[A-Za-z0-9]+$/;
// Reddit serves post permalinks under both the subreddit namespace
// (/r/<sub>/comments/<id>) and the user namespace (/user/<handle>/comments/<id>,
// profile self-posts). Match both, otherwise profile-feed posts resolve no
// target and the picker silently never mounts on them (verified live).
const COMMENTS_PATH_RE = /^\/(?:r|user)\/[^/]+\/comments\/([A-Za-z0-9]+)(?:\/[^/?#]+)?\/?/i;
const GALLERY_PATH_RE = /^\/gallery\/([A-Za-z0-9]+)\/?/i;

interface RedditMatch {
  target: TargetRef;
  actionElement: HTMLElement;
  replacesNative: boolean;
}

const redditAdapter = defineSiteAdapter({
  site: "reddit",
  // Candidates = root posts only. Reddit reactions are post-only; profile
  // comment cards (Overview/Comments tabs) are intentionally NOT candidates.
  findCandidates: ({ root }) => queryAll<HTMLElement>(root, POST_SELECTORS),
  resolveTarget: (el, ctx) => resolveReddit(el, ctx)?.target ?? null,
  resolveBinding: (el, ctx) => {
    const match = resolveReddit(el, ctx);
    if (!match) return null;
    const placement = votePlacement(match.actionElement, match.replacesNative);
    const binding: Binding = {
      anchor: placement.anchor,
      position: "after",
    };
    if (placement.nativeElement) binding.nativeElement = placement.nativeElement;
    if (placement.replaceElement) binding.replaceElement = placement.replaceElement;
    // The vote block carries the up/down buttons as `button[upvote]` /
    // `button[downvote]` (verified live inside shreddit-post's shadow root).
    const like = match.actionElement.querySelector<HTMLElement>("button[upvote]");
    const dislike = match.actionElement.querySelector<HTMLElement>("button[downvote]");
    if (like || dislike) {
      binding.nativeVote = { ...(like ? { like } : {}), ...(dislike ? { dislike } : {}) };
    }
    return binding;
  },
  // Reddit renders posts + action bars inside OPEN shadow roots, mutates on
  // in-page client navigation, and never fires a History event for some route
  // changes - so beyond the standard mutation/nav watch it needs open-shadow-root
  // discovery (the plugin) and click-priming on post links.
  observer: {
    navKey: "pathname",
    attributeFilter: SHADOW_ATTRIBUTE_FILTER,
    linkPrimeSelectors: () => POST_LINK_SELECTORS,
    plugins: [shadowRootDiscovery({ attributeFilter: SHADOW_ATTRIBUTE_FILTER })],
  },
});

// Resolve a post candidate to its target + action element (the vote block, or
// the fallback anchor when none matches); null unless BOTH resolve.
function resolveReddit(el: HTMLElement, ctx: ScanContext): RedditMatch | null {
  return ctx.memo(el, () => {
    const target = extractTarget(el);
    const action = findRootActionElement(el, redditThingId(el));
    return target && action ? { target, ...action } : null;
  });
}

interface VotePlacement {
  anchor: HTMLElement;
  nativeElement?: HTMLElement;
  replaceElement?: HTMLElement;
}

function votePlacement(voteBlock: HTMLElement, replacesNative: boolean): VotePlacement {
  if (!replacesNative) {
    return { anchor: voteBlock };
  }

  const slot = voteBlock.parentElement;
  if (slot && slot.children.length === 1) {
    return {
      anchor: slot,
      nativeElement: voteBlock,
      replaceElement: slot,
    };
  }
  return {
    anchor: voteBlock,
    nativeElement: voteBlock,
    replaceElement: voteBlock,
  };
}

function findRootActionElement(post: HTMLElement, postThingId: string | null): { actionElement: HTMLElement; replacesNative: boolean } | null {
  const voteBlock = findRootVoteBlock(post, postThingId);
  if (voteBlock) return { actionElement: voteBlock, replacesNative: true };

  const fallback = findFallbackActionElement(post);
  if (fallback) return { actionElement: fallback, replacesNative: false };

  return null;
}

function findRootVoteBlock(post: HTMLElement, postThingId: string | null): HTMLElement | null {
  for (const actionBar of queryAllDeep<HTMLElement>(post, ACTION_BAR_SELECTORS)) {
    const actionPostId = actionBar.getAttribute("post-id");
    if (postThingId && actionPostId && actionPostId !== postThingId) continue;

    const voteBlock = findMatchingVoteBlock(actionBar, postThingId ?? actionPostId);
    if (voteBlock) return voteBlock;
  }

  return findMatchingVoteBlock(post, postThingId);
}

function findFallbackActionElement(post: HTMLElement): HTMLElement | null {
  // ONE shadow-piercing walk for all fallback selectors (it used to be a full
  // subtree walk per selector, eight per post); selector order still decides
  // priority, so the resolved element is unchanged. `post` itself leads the
  // candidate list: querySelectorAll never matches its own root, so the
  // trailing `shreddit-post[...]` last-resort selectors would otherwise only
  // ever hit a NESTED post (a crosspost embed), never this one.
  const matches = [post, ...queryAllDeep<HTMLElement>(post, FALLBACK_ACTION_SELECTORS)];
  for (const selector of FALLBACK_ACTION_SELECTORS) {
    const action = matches.find((el) => safeMatches(el, selector) && hasRenderableBox(el));
    if (action) return action;
  }
  return null;
}

function findMatchingVoteBlock(root: ParentNode, postThingId: string | null): HTMLElement | null {
  for (const voteBlock of queryAllDeep<HTMLElement>(root, VOTE_SELECTORS)) {
    const thingId = voteBlock.getAttribute("thing-id");
    if (!thingId || !REDDIT_THING_RE.test(thingId)) continue;
    if (postThingId && thingId !== postThingId) continue;
    return voteBlock;
  }
  return null;
}

function extractTarget(post: HTMLElement): TargetRef | null {
  const thingId = redditThingId(post);
  if (!thingId) return null;

  const url = parseRedditUrl(post.getAttribute("permalink"))?.url ?? parseRedditUrl(location.href)?.url ?? parseRedditUrl(post.getAttribute("content-href"))?.url;
  if (!url) return null;

  return redditTargetFromRef({ thingId, url });
}

export function redditTargetFromRef(ref: { thingId: string; url: string }): TargetRef {
  return { site: "reddit", targetId: ref.thingId, url: ref.url };
}

function redditThingId(post: HTMLElement): string | null {
  const id = post.getAttribute("id");
  if (id && REDDIT_THING_RE.test(id)) return id;

  const permalink = parseRedditUrl(post.getAttribute("permalink"));
  if (permalink) return permalink.thingId;

  const current = parseRedditUrl(location.href);
  if (current) return current.thingId;

  const contentHref = parseRedditUrl(post.getAttribute("content-href"));
  return contentHref?.thingId ?? null;
}

export function extractRedditPostRef(href: string): { thingId: string; url: string } | null {
  return parseRedditUrl(href);
}

function parseRedditUrl(href: string | null): { thingId: string; url: string } | null {
  return parseSiteHref(href, "reddit", (url) => {
    const comments = url.pathname.match(COMMENTS_PATH_RE);
    if (comments?.[1]) {
      const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
      return {
        thingId: `t3_${comments[1]}`,
        url: `https://www.reddit.com${path}`,
      };
    }

    const gallery = url.pathname.match(GALLERY_PATH_RE);
    if (gallery?.[1]) {
      return {
        thingId: `t3_${gallery[1]}`,
        url: `https://www.reddit.com/gallery/${gallery[1]}/`,
      };
    }

    return null;
  });
}

export default redditAdapter;
