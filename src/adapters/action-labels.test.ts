// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { type ActionKind, type ActionRegistry, defineLabelRegistry, type LabelRegistryOptions, STEM, STEM_PARTS, stem } from "./action-labels";

const SVGNS = "http://www.w3.org/2000/svg";

function control(opts: { aria?: string; text?: string; dataIcon?: string; svgAria?: string; path?: string }): HTMLElement {
  const btn = document.createElement("button");
  if (opts.aria != null) btn.setAttribute("aria-label", opts.aria);
  if (opts.text) btn.textContent = opts.text;
  if (opts.dataIcon || opts.svgAria || opts.path) {
    const svg = document.createElementNS(SVGNS, "svg");
    if (opts.dataIcon) svg.setAttribute("data-icon", opts.dataIcon);
    if (opts.svgAria) svg.setAttribute("aria-label", opts.svgAria);
    if (opts.path) {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", opts.path);
      svg.appendChild(p);
    }
    btn.appendChild(svg);
  }
  return btn;
}

// Representative registries exercising each signal type (data-icon, exact
// label, stems, icon path prefix) - not kept in lockstep with the adapters.
const X_REG: ActionRegistry = {
  like: { dataIcon: /^icon-heart/i, stems: STEM.like },
  reply: { dataIcon: /^icon-reply/i, stems: STEM.reply },
  repost: { dataIcon: /^icon-(?:retweet|repost)/i, stems: stem(STEM_PARTS.repost.repost, STEM_PARTS.repost.retweet, STEM_PARTS.repost.retweetUk, STEM_PARTS.repost.poshyryt) },
  bookmark: { dataIcon: /^icon-bookmark/i, stems: STEM.bookmark },
  share: { dataIcon: /^icon-(?:outgoing|share|upload)/i, stems: STEM.share },
};

const FB_REG: ActionRegistry = {
  like: { exact: ["Like"], stems: STEM.like },
  comment: { exact: ["Comment"], stems: STEM.comment },
  share: { exact: ["Share"], stems: STEM.share },
  send: { exact: ["Send"], stems: STEM.send },
};

const THREADS_REG: ActionRegistry = {
  reply: { stems: /^(reply|comment)\b/i, iconPathPrefix: "M12 3C7.02944 3 3 7.02944 3 12" },
  repost: { stems: /^(repost|reshare)\b/i, iconPathPrefix: "M4.51617 6.9986" },
  like: { exact: ["Like", "Liked", "Unlike"] },
};

describe("defineLabelRegistry", () => {
  describe("X - data-icon (language-complete) + stem fallback", () => {
    const reg = defineLabelRegistry(X_REG, { useTextFallback: false });
    const cases: Array<[string, ActionKind, Parameters<typeof control>[0]]> = [
      ["like by icon", "like", { dataIcon: "icon-heart" }],
      ["reply by icon", "reply", { dataIcon: "icon-reply" }],
      ["repost by icon (retweet)", "repost", { dataIcon: "icon-retweet" }],
      ["bookmark by icon", "bookmark", { dataIcon: "icon-bookmark" }],
      ["share by icon (outgoing)", "share", { dataIcon: "icon-outgoing" }],
      ["like RU stem", "like", { aria: "Нравится" }],
      ["like UA stem", "like", { aria: "Подобається" }],
      ["like DE stem", "like", { aria: "Gefällt mir" }],
      ["reply DE stem", "reply", { aria: "Antworten" }],
      ["share DE stem", "share", { aria: "Teilen" }],
      ["repost UA stem", "repost", { aria: "Поширити" }],
    ];
    for (const [name, kind, opts] of cases) {
      it(name, () => expect(reg.classify(control(opts))).toBe(kind));
    }
    it("icon wins over a misleading aria-label (precedence)", () => {
      expect(reg.classify(control({ dataIcon: "icon-heart", aria: "Reply" }))).toBe("like");
    });
    it("a numeric count / More menu is not an action", () => {
      expect(reg.classify(control({ aria: "12" }))).toBeNull();
      expect(reg.classify(control({ aria: "More" }))).toBeNull();
    });
    it("does not fall back to visible text when disabled", () => {
      expect(reg.classify(control({ text: "Like" }))).toBeNull();
    });
  });

  describe("Facebook - exact label + RU/UA stems, count-summary rejected", () => {
    const reg = defineLabelRegistry(FB_REG);
    it("exact EN labels", () => {
      expect(reg.classify(control({ aria: "Like" }))).toBe("like");
      expect(reg.classify(control({ aria: "Comment" }))).toBe("comment");
      expect(reg.classify(control({ aria: "Send" }))).toBe("send");
    });
    it("RU/UA inflected stems", () => {
      expect(reg.classify(control({ aria: "Комментировать" }))).toBe("comment");
      expect(reg.classify(control({ aria: "Поділитися" }))).toBe("share");
      expect(reg.classify(control({ aria: "Переслать" }))).toBe("send");
    });
    it("rejects a reaction count summary (Like: 68)", () => {
      expect(reg.classify(control({ aria: "Like: 68 people" }))).toBeNull();
    });
    it("falls back to visible text when no aria-label (logged-out)", () => {
      expect(reg.classify(control({ text: "Like" }))).toBe("like");
    });
  });

  describe("Threads - SVG path prefix + svg[aria-label]", () => {
    const reg = defineLabelRegistry(THREADS_REG);
    it("reply by exact icon path", () => {
      expect(reg.classify(control({ path: "M12 3C7.02944 3 3 7.02944 3 12 ..." }))).toBe("reply");
    });
    it("repost by icon path", () => {
      expect(reg.classify(control({ path: "M4.51617 6.9986 1 2 3" }))).toBe("repost");
    });
    it("normalises irregular whitespace in the path before matching", () => {
      expect(reg.classify(control({ path: "M12   3C7.02944\n3 3 7.02944 3 12" }))).toBe("reply");
    });
    it("like by svg[aria-label]", () => {
      expect(reg.classify(control({ svgAria: "Unlike" }))).toBe("like");
    });
  });

  describe("reject option (Instagram comment-menu kebab)", () => {
    const reject = /\boption|\bmore\b|\bmenu\b|параметр/iu;
    const reg = defineLabelRegistry({ comment: { stems: STEM.comment } }, { reject } satisfies LabelRegistryOptions);
    it("a Comment-stemmed menu label is rejected, not classified as comment", () => {
      expect(reg.classify(control({ aria: "Comment options" }))).toBeNull();
      expect(reg.classify(control({ aria: "Comment" }))).toBe("comment");
    });
  });

  // CJK/Korean UIs share no alphabet with any stem. These pin BOTH halves: the
  // icon path stays language-complete, and a stem miss is a clean null.
  describe("CJK / Korean labels", () => {
    const xReg = defineLabelRegistry(X_REG, { useTextFallback: false });
    const fbReg = defineLabelRegistry(FB_REG);
    const threadsReg = defineLabelRegistry(THREADS_REG);

    const CJK_LABELS = ["いいね！", "「いいね！」を取り消す", "コメントする", "シェア", "リアクションを変更", "高く評価", "赞", "取消赞", "评论", "分享", "說讚", "좋아요", "댓글"];

    it("classifies by icon even when the aria-label is Japanese", () => {
      expect(xReg.classify(control({ dataIcon: "icon-heart", aria: "いいね" }))).toBe("like");
      expect(xReg.classify(control({ dataIcon: "icon-reply", aria: "返信" }))).toBe("reply");
      expect(xReg.classify(control({ dataIcon: "icon-retweet", aria: "リポスト" }))).toBe("repost");
      expect(threadsReg.classify(control({ path: "M12 3C7.02944 3 3 7.02944 3 12", svgAria: "返信" }))).toBe("reply");
    });

    it("classifies by icon even when the aria-label is Chinese", () => {
      expect(xReg.classify(control({ dataIcon: "icon-heart", aria: "赞" }))).toBe("like");
      expect(xReg.classify(control({ dataIcon: "icon-bookmark", aria: "书签" }))).toBe("bookmark");
      expect(threadsReg.classify(control({ path: "M4.51617 6.9986 1 2 3", svgAria: "转发" }))).toBe("repost");
    });

    // The shipped stems cover EN/RU/UA(/DE) only - a CJK label matching ANY kind
    // would be a false positive, which is worse than the miss it replaces.
    it("never mis-classifies a CJK/Korean label as some other action", () => {
      for (const aria of CJK_LABELS) {
        expect(xReg.classify(control({ aria })), aria).toBeNull();
        expect(fbReg.classify(control({ aria })), aria).toBeNull();
      }
    });

    // Known ceiling, pinned so it is a decision and not a surprise: on a fully
    // localized ja/zh UI a stem-only adapter (Facebook, Instagram) finds no
    // action row via labels. Adding CJK stems is the upgrade path - it needs
    // per-site vocabulary that cannot over-match the neighbouring controls.
    it("stem-only matching is blind on a fully localized CJK UI", () => {
      expect(fbReg.classify(control({ aria: "いいね！" }))).toBeNull();
      expect(fbReg.classify(control({ aria: "赞" }))).toBeNull();
    });

    it("still matches a partially localized label that keeps the English word", () => {
      expect(fbReg.classify(control({ aria: "いいね！ (Like)" }))).toBe("like");
    });
  });
});
