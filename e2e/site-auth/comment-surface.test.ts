// SPDX-License-Identifier: GPL-3.0-or-later
//
// Regression: a Facebook comment's footer mimics a post counts row. Its
// reaction cluster reads as a Like (localized aria «Подобається» - the EN form
// "Like: 4 people" is a count summary and never matched) and sits beside an
// icon-only comment-bubble aria'd «Залишити коментар», while FB's newer comment
// UI ships NO textual Reply link for the comment-row guard to catch. That pair
// passed as a post action row and the picker mounted ON THE COMMENT, keyed to
// the comment's attached photo (verified live, a `facebook:photo:<id>` key on a
// pinned comment). What rejects it now is structural: every comment lives in a
// NESTED [role="article"] (isInNestedArticle).
//
// So the assert is "no mount sits inside a comment", NOT "the page mounts once":
// Facebook appends rotating SUGGESTED posts under a permalink, each a real
// top-level post that legitimately earns its own trigger (seen live beside this
// fixture's own post), so a count is a false red the moment one renders.
//
// This lives in the BRIDGE suite because the shape needs a signed-in,
// non-English Facebook: logged out, the comment footer renders without the
// reaction cluster and the bug cannot fire. The fixture URL comes from
// E2E_AUTHURL_FACEBOOK_PINNED (see .env.e2e.example): a post whose pinned top
// comment carries photo attachments; re-point the env key if it disappears.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bridgeFixture, gotoSettled, SETUP_HOOK_TIMEOUT_MS, siteAuthEnabled, waitForHost } from "./harness";
import { DQ_SRC } from "./probes";
import { authFacebookPinnedUrl } from "./scenarios";

// Comments hydrate after the post, and the buggy mount arrived on those later
// scans - hold the assert open long enough for them to have happened.
const COMMENT_HYDRATE_MS = Number(process.env.E2E_FB_COMMENT_HYDRATE_MS ?? 8_000);

// `onComments` is the bug: a comment's [role="article"] is nested inside the
// post's, so a mount that closes onto a nested one sits on a comment.
const VISIBLE_MOUNTS_SRC = `
${DQ_SRC}
const anchors = dq('[data-khasky-emojery-mounted]').filter((a) => a.getBoundingClientRect().width > 0);
const keyOf = (a) => a.getAttribute('data-khasky-emojery-mounted');
const onComment = (a) => {
  const article = a.closest('[role="article"]');
  return !!article && !!article.parentElement?.closest('[role="article"]');
};
return { all: anchors.map(keyOf).sort(), onComments: anchors.filter(onComment).map(keyOf).sort() };
`;

const fx = bridgeFixture();

(siteAuthEnabled() ? describe : describe.skip)("site-auth: facebook comment surface", () => {
  beforeAll(fx.setup, SETUP_HOOK_TIMEOUT_MS);
  afterAll(fx.teardown);

  test("a permalink with a photo-carrying pinned comment mounts no trigger on a comment", async () => {
    const b = fx.need();
    await gotoSettled(b, authFacebookPinnedUrl(), 4000);
    await waitForHost(b, "facebook");

    await b.waitMs(COMMENT_HYDRATE_MS);
    const mounts = await b.evaluate<{ all: string[]; onComments: string[] }>(VISIBLE_MOUNTS_SRC);
    expect(mounts.all.length, "the permalink's own post must keep its trigger").toBeGreaterThan(0);
    expect(mounts.onComments, `mounted inside a comment's article: ${mounts.onComments.join(", ")}`).toHaveLength(0);
  }, 120_000);
});
