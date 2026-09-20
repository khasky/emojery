// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryAll } from "../shared/dom-query";
import { type Binding, defineSiteAdapter } from "./framework";
import { findFirstAnchor } from "./placement";
import { parseSiteHref, urlTargetResolver } from "./url-target";

// The header's score row, in priority order: the "What's your Vibe?" pill that
// ends it on a movie / series page, the score pill it sits beside, and the
// score list item a collection header carries instead of both.
const SCORE_ROW_SELECTORS = [".actions #vibes_label", ".actions #consensus_pill", "ul.auto.actions > li.chart"];

// TMDB's own emoji reactions: the Vibe pill and the reaction strip beside the
// score. These are what the picker stands in for, so "Hide original buttons"
// hides them - the score percentage itself is not a reaction and stays.
const NATIVE_REACTION_SELECTORS = [".actions #vibes_label", ".actions ul.consensus_reaction_items"];

// The trigger takes the end of the score row. A collection's row is a `<ul>`, so
// the host is wrapped in the child tag that row expects; the margin matches the
// `mr-4` rhythm the row's own pills carry.
const ROW_WRAPPER = { tagName: "div", style: "display:inline-flex;align-items:center;margin-left:16px" };
const LIST_WRAPPER = { tagName: "li", style: "display:inline-flex;align-items:center;margin-left:16px" };

// `/movie/238-the-godfather`, `/tv/1396`, `/collection/531241-...`. The slug is
// decoration TMDB rewrites (a wrong one 301s to the bare id), so only the
// numeric id is the identity.
const TITLE_PATH_RE = /^\/(movie|tv|collection)\/(\d{1,12})(?:-[^/]*)?\/?$/;

const tmdbAdapter = defineSiteAdapter({
  site: "tmdb",
  findCandidates: ({ root }) => {
    const scoreRow = findFirstAnchor(root, [{ selectors: SCORE_ROW_SELECTORS }]);
    return scoreRow ? [scoreRow] : [];
  },
  resolveTarget: urlTargetResolver({ parse: extractTmdbTitleRef, toTarget: tmdbTargetFromRef }),
  resolveBinding: (scoreRow, { root }) => {
    const binding: Binding = {
      anchor: scoreRow,
      position: "after",
      wrapper: scoreRow.parentElement?.tagName === "UL" ? LIST_WRAPPER : ROW_WRAPPER,
    };
    const natives = queryAll<HTMLElement>(root, NATIVE_REACTION_SELECTORS);
    if (natives.length > 0) binding.nativeElement = natives;
    return binding;
  },
  observer: { navKey: "pathname" },
});

// Exported under its `extract...Ref` name so the URL parsing stays directly
// testable and `target-contract.ts` can derive from a bare URL.
export function extractTmdbTitleRef(href: string | null): { titleId: string } | null {
  return parseSiteHref(href, "tmdb", (url) => {
    const match = url.pathname.match(TITLE_PATH_RE);
    const kind = match?.[1];
    const id = match?.[2];
    return kind && id ? { titleId: `${kind}/${id}` } : null;
  });
}

export function tmdbTargetFromRef(ref: { titleId: string }): TargetRef {
  return {
    site: "tmdb",
    targetId: ref.titleId,
    url: `https://www.themoviedb.org/${ref.titleId}`,
  };
}

export default tmdbAdapter;
