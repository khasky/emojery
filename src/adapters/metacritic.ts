// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryFirst } from "../shared/dom-query";
import { type Binding, defineSiteAdapter } from "./framework";
import { parseSiteHref, urlTargetResolver } from "./url-target";

// The hero's score column, which stacks Metascore, User Score and the site's own
// My Score widget. The testid is the stable handle - the column itself is found
// as its parent, so the authored class names below are only the fallback for a
// page that ships the column with no score in it yet.
const SCORE_ITEM_SELECTORS = ['[data-testid="product-score"]'];
const SCORE_COLUMN_SELECTORS = [".hero-scores", ".product-hero__scores"];

// The trigger takes the foot of that column, on its own line. The column stacks
// block children, so the wrapper only needs to carry the gap.
const COLUMN_WRAPPER = { tagName: "div", style: "margin-top:16px" };

// `/movie/<slug>/`, `/tv/<slug>/`, `/tv/<slug>/season-5/`, `/game/<slug>/`. The
// slug is case-SENSITIVE here (a re-cased path 404s), so unlike Rotten Tomatoes
// and IMDb the id keeps what the URL carries.
const PRODUCT_PATH_RE = /^\/(movie|game)\/([a-z0-9-]{1,120})\/?$/;
const TV_PATH_RE = /^\/tv\/([a-z0-9-]{1,120})(?:\/(season-\d{1,3}))?\/?$/;

const metacriticAdapter = defineSiteAdapter({
  site: "metacritic",
  findCandidates: ({ root }) => {
    const column = findScoreColumn(root);
    return column ? [column] : [];
  },
  resolveTarget: urlTargetResolver({ parse: extractMetacriticProductRef, toTarget: metacriticTargetFromRef }),
  resolveBinding: (column): Binding => ({
    anchor: column,
    position: "append",
    wrapper: COLUMN_WRAPPER,
    // One target per page, and the column sits under a tall video hero - the
    // foot of it starts below the fold on a laptop, where a lazy mount reads as
    // "no reaction button" until the reader scrolls.
    mountImmediately: true,
  }),
  observer: { navKey: "pathname" },
});

function findScoreColumn(root: ParentNode): HTMLElement | null {
  const item = queryFirst<HTMLElement>(root, SCORE_ITEM_SELECTORS);
  return item?.parentElement ?? queryFirst<HTMLElement>(root, SCORE_COLUMN_SELECTORS);
}

// The id is the product's own path - `movie/<slug>`, `game/<slug>`, `tv/<slug>`
// and the season below it, each a page Metacritic scores separately.
export function extractMetacriticProductRef(href: string | null): { productId: string } | null {
  return parseSiteHref(href, "metacritic", (url) => {
    const product = url.pathname.match(PRODUCT_PATH_RE);
    if (product?.[1] && product[2]) return { productId: `${product[1]}/${product[2]}` };

    const tv = url.pathname.match(TV_PATH_RE);
    if (!tv?.[1]) return null;
    return { productId: `tv/${tv[1]}${tv[2] ? `/${tv[2]}` : ""}` };
  });
}

export function metacriticTargetFromRef(ref: { productId: string }): TargetRef {
  return {
    site: "metacritic",
    targetId: ref.productId,
    url: `https://www.metacritic.com/${ref.productId}/`,
  };
}

export default metacriticAdapter;
