// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { type Binding, defineSiteAdapter } from "./framework";
import { findFirstAnchor } from "./placement";
import { parseSiteHref, urlTargetResolver } from "./url-target";

// The header card's own action row - Rate / Want / Played / Favorite.
const ACTION_ROW_SELECTORS = [".action-buttons"];

// Its 4 buttons are each `w-25`, so a fifth would wrap onto a second line and
// break the row. The trigger takes the line below instead, in a grid cell of the
// site's own shape - the row it joins already stacks cells this way.
const ROW_BELOW_WRAPPER = { tagName: "div", className: "col-12 col-lg-9 px-3" };

// `/game/<id>/<slug>`. The slug segment is REQUIRED (a bare `/game/<id>` is a
// 404) but its content is ignored - any slug serves the game and the page points
// its canonical at the right one - so only the numeric id is the identity.
const GAME_PATH_RE = /^\/game\/(\d{1,12})\/([^/]+)\/?$/;

const opencriticAdapter = defineSiteAdapter({
  site: "opencritic",
  findCandidates: ({ root }) => {
    const actionRow = findFirstAnchor(root, [{ selectors: ACTION_ROW_SELECTORS }]);
    return actionRow ? [actionRow] : [];
  },
  resolveTarget: urlTargetResolver({ parse: extractOpenCriticGameRef, toTarget: opencriticTargetFromRef }),
  resolveBinding: (actionRow): Binding => ({ anchor: actionRow, position: "after", wrapper: ROW_BELOW_WRAPPER }),
  observer: { navKey: "pathname" },
});

export function extractOpenCriticGameRef(href: string | null): { gameId: string; slug: string } | null {
  return parseSiteHref(href, "opencritic", (url) => {
    const match = url.pathname.match(GAME_PATH_RE);
    const gameId = match?.[1];
    const slug = match?.[2];
    return gameId && slug ? { gameId, slug } : null;
  });
}

// The slug is a parameter rather than part of the id: the site requires the
// segment to serve the page, so the stored URL keeps the one the page carried -
// the same split Amazon makes between its regional host and the contractual ASIN.
export function opencriticTargetFromRef(ref: { gameId: string; slug: string }): TargetRef {
  return {
    site: "opencritic",
    targetId: ref.gameId,
    url: `https://opencritic.com/game/${ref.gameId}/${ref.slug}`,
  };
}

export default opencriticAdapter;
