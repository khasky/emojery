// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The content script only ever runs on facebook.com, so model the test document
 * as a Facebook page: the click-origin cases below drive location via
 * history.replaceState, and isStandalonePhotoViewerPage host-gates what it reads.
 * @vitest-environment-options { "url": "https://www.facebook.com/" }
 */
import { describe, expect, it } from "vitest";
import { isPaintedFill } from "./css-alpha";
import facebookAdapter, { COMPOSER_ACTION_STEM, clickedPhotoStoryUrls, extractFbId, FB_LOCALIZED_ACTION_LABELS, FB_REACTION_MENU_ARIA, FB_REMOVE_RE, FB_STEMS, facebookTarget, fbLikeLabelPressed, fbUrlFallbackId, groupStoryPermalinkFromPhotoUrl, targetFromPhotoUrl, targetFromWatchUrl } from "./facebook";
import { expectMatchesRegistryHosts } from "./test-fixtures";

const PFBID = "pfbid02SCZNCYjkN4icYTieWwJL33vvDvfftmhbzebFRxPUvbUCuWoMhfG5SZrzSPihjMVgl";

describe("facebook adapter", () => {
  it("matches www.facebook.com and m.facebook.com only", () => {
    expectMatchesRegistryHosts(facebookAdapter, "facebook");
    // facebook.com is a PARSE host (urlHosts) but NOT a run host - must not match.
    expect(facebookAdapter.matches("facebook.com")).toBe(false);
    expect(facebookAdapter.matches("instagram.com")).toBe(false);
  });
});

// The label table is data read off facebook.com, so what a unit test can hold it
// to is the shape the matcher depends on: one action per string, and no string a
// count summary would swallow.
describe("FB_LOCALIZED_ACTION_LABELS", () => {
  const forms = new Map(FB_LOCALIZED_ACTION_LABELS);
  const like = forms.get("Like") ?? [];
  const comment = forms.get("Comment") ?? [];
  const key = (label: string) => label.normalize("NFC").toLowerCase();

  it("keeps the Like and Comment vocabularies disjoint", () => {
    const shared = like.map(key).filter((label) => comment.map(key).includes(label));
    expect(shared, "a string matching both actions makes the row asymmetry meaningless").toEqual([]);
  });

  it("ships no label a count summary would swallow", () => {
    // localizedActionLabel drops any aria carrying a colon ("Gefällt mir: 83.051
    // Personen"), so a table entry with one could never match.
    expect([...like, ...comment].filter((label) => label.includes(":"))).toEqual([]);
  });

  it("carries the locales the EN/RU/UA stems cannot read", () => {
    for (const label of ["Gefällt mir", "「いいね！」", "좋아요", "赞", "ถูกใจ", "Vind ik leuk"]) {
      expect(like, label).toContain(label);
    }
    for (const label of ["Kommentieren", "コメントする", "댓글", "评论", "แสดงความคิดเห็น"]) {
      expect(comment, label).toContain(label);
    }
  });

  it("stores every form composed, so the map keys are canonical", () => {
    const decomposed = [...like, ...comment].filter((label) => label !== label.normalize("NFC"));
    expect(decomposed, "normalizeLabel composes the page side; a decomposed literal here would still work but hides the pairing").toEqual([]);
  });
});

describe("COMPOSER_ACTION_STEM (composer rows are never post action rows)", () => {
  // Live-verified composer button labels per UI language. The UA profile
  // composer ("Ефір / Світлина/відео / Життєва подія") matched NONE of the old
  // stems - the geometry fallback then mounted the trigger inside the composer
  // on the user's own profile (bug: appear-in-composer).
  const composerLabels = [
    // EN (own profile + feed)
    "Live video",
    "Photo/video",
    "Life update",
    "Life event",
    "Feeling/activity",
    // RU
    "Прямой эфир",
    "Фото/видео",
    "Событие из жизни",
    "Чувства/действия",
    // UA (own profile - the bug's exact row)
    "Ефір",
    "Світлина/відео",
    "Життєва подія",
    "Почуття/дія",
    // RU group composer. Regression pin: the stem once spelled this atom with
    // `\w*`, which is ASCII-only in JS regexes, so no Cyrillic form ever matched.
    "Анонимная публикация",
    "Анонимный пост",
  ];
  const postActionLabels = ["Like", "Comment", "Share", "Send", "Нравится", "Комментировать", "Поделиться", "Отправить", "Вподобати", "Коментувати", "Поділитися", "Надіслати"];

  it("matches every EN/RU/UA composer label", () => {
    for (const label of composerLabels) {
      expect(label).toMatch(COMPOSER_ACTION_STEM);
    }
  });

  it("matches no post action label", () => {
    for (const label of postActionLabels) {
      expect(label).not.toMatch(COMPOSER_ACTION_STEM);
    }
  });
});

describe("reacted action row (split Like button + reactions chevron)", () => {
  // EN labels captured live on facebook.com/allo. Facebook renders the like
  // control as two buttons whose labels BOTH change once a reaction is set:
  //   unreacted -> "Like"        + "React"
  //   reacted   -> "Remove Haha" + "Change Haha reaction"
  // Before the fix a reacted post lost its picker: the chevron matched the like
  // stem (two post-action Likes in one row broke container resolution) and an
  // emoji reaction matched no stem at all (no Like left in the row).
  const chevronLabels = ["Change Like reaction", "Change Haha reaction", "Change Love reaction", "Изменить реакцию", "Змінити реакцію"];
  // The RU/UA remove forms spell the word "reaction" out - they must still read
  // as a pressed Like, not as the chevron (the реакц test alone would swallow
  // them, which is what unmounted the trigger from every reacted RU/UA post).
  const pressedLikeLabels = [
    "Remove Like",
    "Remove Love",
    "Remove Care",
    "Remove Haha",
    "Remove Wow",
    "Remove Sad",
    "Remove Angry",
    "Убрать «Нравится»",
    "Убрать реакцию «Нравится»",
    "Удалить «Нравится»",
    "Видалити «Подобається»",
    "Видалити реакцію «Подобається»",
    "Скасувати реакцію «Подобається»",
    "Скасувати «Подобається»",
  ];
  const postActionLabels = ["Like", "React", "Comment", "Leave a comment", "Share", "Send", "Send this to friends or post it on your profile.", "Нравится", "Комментировать", "Поділитися", "Надіслати"];

  it("rejects every flyout-chevron label", () => {
    for (const label of chevronLabels) {
      expect(label).toMatch(FB_REACTION_MENU_ARIA);
      expect(label).not.toMatch(FB_REMOVE_RE);
    }
  });

  it("rejects the chevron BEFORE the like stem can claim it", () => {
    // Load-bearing: "Change Like reaction" matches the like stem, so without the
    // reject it counts as a second post-action Like in the row.
    expect("Change Like reaction").toMatch(FB_STEMS.like);
    expect("Change Like reaction").toMatch(FB_REACTION_MENU_ARIA);
    expect("Change Like reaction").not.toMatch(FB_REMOVE_RE);
  });

  it("reads every pressed-Like label as a Like", () => {
    for (const label of pressedLikeLabels) {
      expect(label).toMatch(FB_REMOVE_RE);
    }
  });

  it("leaves unreacted post action labels untouched", () => {
    for (const label of postActionLabels) {
      expect(label).not.toMatch(FB_REACTION_MENU_ARIA);
      expect(label).not.toMatch(FB_REMOVE_RE);
    }
  });
});

describe("extractFbId", () => {
  it("returns the pfbid slug from a modern /posts/ permalink", () => {
    expect(extractFbId(`https://www.facebook.com/zuck/posts/${PFBID}`)).toBe(PFBID);
  });

  it("returns the numeric id from a legacy /posts/ permalink", () => {
    expect(extractFbId("https://www.facebook.com/zuck/posts/1234567890")).toBe("1234567890");
  });

  it("handles /permalink/ and /videos/ paths", () => {
    expect(extractFbId("https://www.facebook.com/groups/dev/permalink/9876543210")).toBe("9876543210");
    expect(extractFbId("https://www.facebook.com/zuck/videos/100200300")).toBe("100200300");
  });

  it("handles /reel/ permalinks (Page-wall date links)", () => {
    expect(extractFbId("https://www.facebook.com/reel/986527210792212/")).toBe("986527210792212");
    // The date link carries a volatile per-render __cft__ token; the id
    // must still come out stable.
    expect(extractFbId("https://www.facebook.com/reel/986527210792212/?__cft__[0]=AZben1eKFn7l")).toBe("986527210792212");
  });

  it("falls back to ?story_fbid= for the legacy query form", () => {
    expect(extractFbId("https://www.facebook.com/permalink.php?story_fbid=987&id=42")).toBe("987");
  });

  it("rejects a non-id ?story_fbid= value", () => {
    expect(extractFbId("https://www.facebook.com/permalink.php?story_fbid=abc")).toBeNull();
  });

  it("does not treat photo-viewer fbid query links as posts", () => {
    expect(extractFbId("https://www.facebook.com/photo/?fbid=123456789")).toBeNull();
    expect(extractFbId("https://www.facebook.com/photo.php?fbid=123456789")).toBeNull();
  });
});

describe("facebookTarget (url re-derives to targetId - lockstep)", () => {
  const NUMERIC = "122174589896889276";

  it("rewrites the url to carry the numeric story id when upgrading off a pfbid", () => {
    const target = facebookTarget(NUMERIC, `https://www.facebook.com/permalink.php?story_fbid=${PFBID}&id=61576678289841`);
    expect(target.targetId).toBe(NUMERIC);
    expect(extractFbId(target.url)).toBe(NUMERIC);
    expect(target.url).toContain("id=61576678289841");
  });

  it("rewrites a photo url (which derives to nothing) to the numeric story id", () => {
    const target = facebookTarget(NUMERIC, "https://www.facebook.com/photo/?fbid=200000000000000");
    expect(extractFbId(target.url)).toBe(NUMERIC);
  });

  it("keeps the source url when it already re-derives to the numeric id", () => {
    const url = "https://www.facebook.com/zuck/posts/4271475406496438";
    const target = facebookTarget("4271475406496438", url);
    expect(target.url).toBe(url);
  });

  it("keeps the source url for non-numeric ids (pfbid / photo:<media>)", () => {
    const url = `https://www.facebook.com/zuck/posts/${PFBID}`;
    expect(facebookTarget(PFBID, url).url).toBe(url);
    const photoUrl = "https://www.facebook.com/photo/?fbid=12345678";
    expect(facebookTarget("photo:12345678", photoUrl).url).toBe(photoUrl);
  });
});

// Regression for the multi-photo split: every photo of one timeline post opens
// as `?fbid=<perPhoto>&set=pcb.<postId>` - keying on the per-photo fbid gave the
// first photo's viewer a target the feed reaction never matched. All photos (and
// the feed card's photo links) must converge on the ONE pcb post id.
describe("targetFromPhotoUrl (multi-photo pcb set)", () => {
  const POST_ID = "1504490531717711";
  const PHOTO_1 = `https://www.facebook.com/photo/?fbid=1504490505051047&set=pcb.${POST_ID}`;
  const PHOTO_2 = `https://www.facebook.com/photo/?fbid=1504490501717714&set=pcb.${POST_ID}`;

  it("keys every photo of the post on the pcb post id, with a re-derivable url", () => {
    const first = targetFromPhotoUrl(PHOTO_1);
    const second = targetFromPhotoUrl(PHOTO_2);
    expect(first.targetId).toBe(POST_ID);
    expect(second.targetId).toBe(POST_ID);
    expect(extractFbId(first.url)).toBe(POST_ID);
  });

  it("still keys a set-less photo on its media id", () => {
    expect(targetFromPhotoUrl("https://www.facebook.com/photo/?fbid=12345678").targetId).toBe("photo:12345678");
  });
});

// An album-set photo viewer (`set=a.`, no group marker) can only be tied back
// to the group post it was opened from by the click that opened it (see
// photoClickContextCapture). The stash re-keys the STANDALONE VIEWER only -
// feed/timeline cards of the same media keep their own context.
describe("targetFromPhotoUrl (click-origin group story stash)", () => {
  const PHOTO = "https://www.facebook.com/photo/?fbid=2083798162574069&set=a.101945470759358";
  const STORY = "https://www.facebook.com/groups/1921914684493472/posts/29083810141210559/";

  it("keys the standalone viewer on the clicked group story", () => {
    history.replaceState(null, "", "/photo/?fbid=2083798162574069&set=a.101945470759358");
    clickedPhotoStoryUrls.set("2083798162574069", STORY);
    try {
      expect(targetFromPhotoUrl(PHOTO).targetId).toBe("29083810141210559");
    } finally {
      clickedPhotoStoryUrls.clear();
      history.replaceState(null, "", "/");
    }
  });

  it("keeps the photo-entity key off the viewer page and without a click", () => {
    history.replaceState(null, "", "/");
    clickedPhotoStoryUrls.set("2083798162574069", STORY);
    try {
      expect(targetFromPhotoUrl(PHOTO).targetId).toBe("photo:2083798162574069");
    } finally {
      clickedPhotoStoryUrls.clear();
    }
    history.replaceState(null, "", "/photo/?fbid=2083798162574069&set=a.101945470759358");
    try {
      expect(targetFromPhotoUrl(PHOTO).targetId).toBe("photo:2083798162574069");
    } finally {
      history.replaceState(null, "", "/");
    }
  });
});

describe("targetFromWatchUrl (watch <-> reel convergence)", () => {
  const ID = "995564906790220";

  it("keys the watch page on the bare numeric video id (not video:<id>)", () => {
    const target = targetFromWatchUrl(`https://www.facebook.com/watch/?v=${ID}`);
    expect(target.targetId).toBe(ID);
    expect(target.site).toBe("facebook");
  });

  it("converges with the /reel/<id> and /videos/<id> id derivation", () => {
    const watch = targetFromWatchUrl(`https://www.facebook.com/watch/?v=${ID}`);
    // The reel viewer / feed video post derive the id via extractFbId off the
    // /reel/ | /videos/ forms - all three must be the same key.
    expect(extractFbId(`https://www.facebook.com/reel/${ID}`)).toBe(watch.targetId);
    expect(extractFbId(`https://www.facebook.com/zuck/videos/${ID}`)).toBe(watch.targetId);
  });
});

// Photo-post core: a group photo URL carries the post's group-story id in
// `set=gm.<storyId>` - the same id the group permalink / feed date link resolve
// to. Rebuilding the group permalink lets the photo view key on that story id
// (stable, per-post) instead of the shared `photo:<mediaId>`.
describe("groupStoryPermalinkFromPhotoUrl (photo-post core)", () => {
  const PHOTO = "https://www.facebook.com/photo?fbid=10237309205982009&set=gm.2154737235134748&idorvanity=1208731756401972";

  it("rebuilds the group permalink, which extractFbId resolves to the story id", () => {
    const permalink = groupStoryPermalinkFromPhotoUrl(PHOTO);
    expect(permalink).toBe("https://www.facebook.com/groups/1208731756401972/posts/2154737235134748/");
    // The whole point: photo view and group permalink collapse to ONE key.
    expect(extractFbId(permalink!)).toBe("2154737235134748");
  });

  it("ignores non-group photo sets (timeline pcb./album a.) and missing set", () => {
    expect(groupStoryPermalinkFromPhotoUrl("https://www.facebook.com/photo?fbid=123456789&set=pcb.987654321")).toBeNull();
    expect(groupStoryPermalinkFromPhotoUrl("https://www.facebook.com/photo?fbid=123456789&set=a.555&idorvanity=42")).toBeNull();
    expect(groupStoryPermalinkFromPhotoUrl("https://www.facebook.com/photo?fbid=123456789")).toBeNull();
  });

  it("requires the group (idorvanity) to build a permalink", () => {
    expect(groupStoryPermalinkFromPhotoUrl("https://www.facebook.com/photo?fbid=123456789&set=gm.2154737235134748")).toBeNull();
  });
});

describe("fbUrlFallbackId", () => {
  it("collapses tracking-param and host variants of one permalink to one id", () => {
    const base = fbUrlFallbackId("https://www.facebook.com/story.php?id=42");
    expect(base).toMatch(/^url:[0-9a-z]+$/);
    expect(fbUrlFallbackId("https://www.facebook.com/story.php?id=42&__tn__=R&ref=foo&fbclid=xyz")).toBe(base);
    expect(fbUrlFallbackId("https://m.facebook.com/story.php?id=42#comments")).toBe(base);
    expect(fbUrlFallbackId("https://www.facebook.com/story.php?fbclid=xyz&id=42")).toBe(base);
  });

  it("keeps distinct permalinks distinct", () => {
    expect(fbUrlFallbackId("https://www.facebook.com/story.php?id=42")).not.toBe(fbUrlFallbackId("https://www.facebook.com/story.php?id=43"));
  });

  it("preserves identity-bearing params while dropping noise", () => {
    expect(fbUrlFallbackId("https://www.facebook.com/story.php?id=42&__tn__=A")).not.toBe(fbUrlFallbackId("https://www.facebook.com/story.php?id=99&__tn__=A"));
  });

  it("handles a bare path (no identity params) and unparseable input without throwing", () => {
    expect(fbUrlFallbackId("https://www.facebook.com/groups/dev/permalink/")).toMatch(/^url:[0-9a-z]+$/);
    expect(fbUrlFallbackId("http://[invalid")).toMatch(/^url:[0-9a-z]+$/);
  });
});

// Auto-press pressed-state read on the split Like button: labels captured live
// (same vectors as the registry suite above).
describe("fbLikeLabelPressed", () => {
  it("reads every pressed-Like label as pressed", () => {
    for (const label of ["Remove Like", "Remove Haha", "Remove Angry", "Убрать «Нравится»", "Видалити «Подобається»", "Скасувати «Подобається»"]) {
      expect(fbLikeLabelPressed(label), label).toBe(true);
    }
  });

  it("reads the resting Like as unpressed", () => {
    expect(fbLikeLabelPressed("Like")).toBe(false);
    expect(fbLikeLabelPressed("Нравится")).toBe(false);
  });

  it("stays unknown on unreadable labels - unknown must never press", () => {
    expect(fbLikeLabelPressed("")).toBeNull();
    expect(fbLikeLabelPressed("Comment")).toBeNull();
    expect(fbLikeLabelPressed("Share")).toBeNull();
  });

  // Facebook's CJK/Korean labels share nothing with the EN/RU/UA stems, so the
  // read must stay UNKNOWN: a `false` there would re-press a reaction the user
  // already set, and a `true` would make un-react clear someone else's.
  it("stays unknown on CJK/Korean labels rather than guessing", () => {
    for (const label of ["いいね！", "「いいね！」を取り消す", "超いいね！", "赞", "取消赞", "좋아요"]) {
      expect(fbLikeLabelPressed(label), label).toBeNull();
    }
  });
});

// Drives the filled-chip probe that keeps the language-blind geometry fallback
// off standalone CTA pills. Flat post actions must read as unfilled, and a real
// pill as filled - the whole point is a language-independent counterpart to the
// wording guards, so a misread here re-opens the "picker mounts on the profile
// header" class of bug.
describe("isPaintedFill - the filled-chip probe's background read", () => {
  it("reads every zero-alpha spelling as unpainted", () => {
    // `color(... / 0)` is the drift the shared helper closed: the FB-only copy
    // took any `color(...)` function as painted.
    for (const value of ["transparent", "rgba(0, 0, 0, 0)", "rgba(0, 0, 0, 0.0)", "rgba(255, 255, 255, 0)", "rgb(0 0 0 / 0)", "rgb(0 0 0 / 0%)", "color(display-p3 1 0.18 0.25 / 0)"]) {
      expect(isPaintedFill(value), value).toBe(false);
    }
  });

  it("reads an unreadable value as unknown - the probe treats it as no fill", () => {
    expect(isPaintedFill("")).toBeNull();
    expect(isPaintedFill("  ")).toBeNull();
  });

  it("reads a three-component rgb() as opaque - it carries no alpha at all", () => {
    // The trap the old exact-"0" regex sidestepped by demanding the `rgba(`
    // prefix: `rgb(0, 0, 0)` ends in ", 0)" but is opaque BLACK, a filled pill.
    expect(isPaintedFill("rgb(0, 0, 0)")).toBe(true);
    expect(isPaintedFill("rgb(24 25 26)")).toBe(true);
  });

  it("reads a partial alpha as painted and leaves unknown syntaxes painted", () => {
    expect(isPaintedFill("rgba(255, 255, 255, 0.5)")).toBe(true);
    expect(isPaintedFill("color(display-p3 1 0.18 0.25)")).toBe(true);
  });
});
