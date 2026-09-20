// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryAll } from "../shared/dom-query";
import { type Binding, defineSiteAdapter } from "./framework";
import { parseSiteHref, urlTargetResolver } from "./url-target";
import { hasRenderableBox } from "./visual-action-row";

// `media-scorecard` is a custom element whose Tomatometer / Popcornmeter blocks
// live in an OPEN shadow root, so the anchor is read through `shadowRoot` - a
// document query stops at the host.
const SCORECARD_SELECTORS = ["media-scorecard"];
// Priority order inside that shadow root: the Popcornmeter block, which the
// trigger sits to the right of; the Tomatometer block, for a series page that
// ships no audience score; the row holding both, if the card restructures.
const SCORE_BLOCK_SELECTORS = [".audience-score-wrap", ".critics-score-wrap", ".score-wrap"];

// The score blocks are flex items of a row with free space to their right; the
// trigger takes that space and holds the row's vertical centre.
const TRIGGER_WRAPPER = { tagName: "span", style: "align-self:center;display:inline-flex;margin-left:32px" };

const MOVIE_PATH_RE = /^\/m\/([a-z0-9_.-]+)\/?$/;
const TV_PATH_RE = /^\/tv\/([a-z0-9_.-]+)(?:\/(s\d{1,3})(?:\/(e\d{1,4}))?)?\/?$/;

const rottentomatoesAdapter = defineSiteAdapter({
  site: "rottentomatoes",
  findCandidates: ({ root }) => {
    const scoreBlock = findScoreBlock(root);
    return scoreBlock ? [scoreBlock] : [];
  },
  resolveTarget: urlTargetResolver({ parse: extractRottenTomatoesTitleRef, toTarget: rottentomatoesTargetFromRef }),
  resolveBinding: (scoreBlock): Binding => ({
    anchor: scoreBlock,
    position: "append",
    wrapper: TRIGGER_WRAPPER,
    // One target per page, and the hero above the card pushes it under the fold
    // on a short window - a lazy mount there reads as "no reaction button".
    mountImmediately: true,
  }),
  observer: {
    navKey: "pathname",
    // The card ships server-rendered as `skeleton="panel"` and drops the attribute
    // when it upgrades and attaches its shadow root. That attribute change is the
    // only announcement the anchor exists: a shadow attach mutates nothing a
    // document observer can see.
    attributeFilter: ["skeleton", "hide-audience-score"],
  },
});

function findScoreBlock(root: ParentNode): HTMLElement | null {
  for (const card of queryAll<HTMLElement>(root, SCORECARD_SELECTORS)) {
    const shadow = card.shadowRoot;
    if (!shadow) continue;
    for (const block of queryAll<HTMLElement>(shadow, SCORE_BLOCK_SELECTORS)) {
      if (hasRenderableBox(block)) return block;
    }
  }
  return null;
}

// The id is the title's own path - `m/<slug>`, `tv/<slug>`, and the season /
// episode below it, each a page with its own scores on Rotten Tomatoes.
export function extractRottenTomatoesTitleRef(href: string | null): { titleId: string } | null {
  return parseSiteHref(href, "rottentomatoes", (url) => {
    // Rotten Tomatoes routes a title case-insensitively (`/m/The_Odyssey_2026`
    // 301s to the lowercase slug), so the id folds case or one title splits its
    // counts across two keys.
    const pathname = url.pathname.toLowerCase();

    const movie = pathname.match(MOVIE_PATH_RE);
    if (movie?.[1]) return { titleId: `m/${movie[1]}` };

    const tv = pathname.match(TV_PATH_RE);
    if (!tv?.[1]) return null;
    const season = tv[2] ? `/${tv[2]}` : "";
    const episode = tv[3] ? `/${tv[3]}` : "";
    return { titleId: `tv/${tv[1]}${season}${episode}` };
  });
}

export function rottentomatoesTargetFromRef(ref: { titleId: string }): TargetRef {
  return {
    site: "rottentomatoes",
    targetId: ref.titleId,
    url: `https://www.rottentomatoes.com/${ref.titleId}`,
  };
}

export default rottentomatoesAdapter;
