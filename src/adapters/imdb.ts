// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { type Binding, defineSiteAdapter } from "./framework";
import { findFirstAnchor } from "./placement";
import { parseSiteHref, urlTargetResolver } from "./url-target";

// The hero's rating bar, by the one handle that survives a restyle: IMDb's class
// names are generated per build. POPULARITY is missing on a title nobody is
// watching, so the chain ends on the 2 items every title carries.
const RATING_BAR_ITEM_SELECTORS = ['[data-testid="hero-rating-bar__popularity"]', '[data-testid="hero-rating-bar__user-rating"]', '[data-testid="hero-rating-bar__aggregate-rating"]'];

// The trigger takes the end of the bar - which is the bar's own parent, not the
// item found above, so a title missing POPULARITY still mounts after the last
// item it does have. The margin matches the gap the bar's items keep.
const BAR_WRAPPER = { tagName: "div", style: "display:inline-flex;align-items:center;align-self:center;margin-left:16px" };

// `/title/tt33764258/`, with or without the trailing slash and whatever `ref_`
// query the link carried. Movies, series and episodes share this one namespace.
const TITLE_PATH_RE = /^\/title\/(tt\d{1,12})\/?$/;

const imdbAdapter = defineSiteAdapter({
  site: "imdb",
  findCandidates: ({ root }) => {
    const barItem = findFirstAnchor(root, [{ selectors: RATING_BAR_ITEM_SELECTORS }]);
    return barItem ? [barItem] : [];
  },
  resolveTarget: urlTargetResolver({ parse: extractImdbTitleRef, toTarget: imdbTargetFromRef }),
  resolveBinding: (barItem): Binding | null => {
    const bar = barItem.parentElement;
    return bar ? { anchor: bar, position: "append", wrapper: BAR_WRAPPER } : null;
  },
  observer: { navKey: "pathname" },
});

export function extractImdbTitleRef(href: string | null): { titleId: string } | null {
  return parseSiteHref(href, "imdb", (url) => {
    // IMDb routes the const case-insensitively (`/title/TT33764258/` serves the
    // page and points its canonical at the lowercase form), so the id folds case
    // or one title splits its counts across two keys.
    const match = url.pathname.toLowerCase().match(TITLE_PATH_RE);
    return match?.[1] ? { titleId: match[1] } : null;
  });
}

export function imdbTargetFromRef(ref: { titleId: string }): TargetRef {
  return {
    site: "imdb",
    targetId: ref.titleId,
    url: `https://www.imdb.com/title/${ref.titleId}/`,
  };
}

export default imdbAdapter;
