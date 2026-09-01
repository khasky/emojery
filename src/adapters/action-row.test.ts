// SPDX-License-Identifier: GPL-3.0-or-later
// rejectCommentRow is a framework contract (markers win over reply; positive
// recognition only), so its rows are built from NEUTRAL sentinel labels - no
// supported site's vocabulary or layout. The real per-site vocabularies are
// pinned separately below as single-element classification, and live rows are
// e2e's job.
import { describe, expect, it } from "vitest";
import { defineLabelRegistry, STEM } from "./action-labels";
import { rejectCommentRow } from "./action-row";

const sentinelReg = defineLabelRegistry({
  like: { exact: ["sentinel-like"] },
  comment: { exact: ["sentinel-comment"] },
  share: { exact: ["sentinel-share"] },
  reply: { exact: ["sentinel-reply"] },
});

function btn(aria: string): HTMLElement {
  const b = document.createElement("div");
  b.setAttribute("role", "button");
  b.setAttribute("aria-label", aria);
  return b;
}

function row(...controls: HTMLElement[]): HTMLElement {
  const r = document.createElement("div");
  for (const c of controls) {
    const slot = document.createElement("div");
    slot.appendChild(c);
    r.appendChild(slot);
  }
  document.body.appendChild(r);
  return r;
}

describe("rejectCommentRow (framework contract over sentinel rows)", () => {
  const reject = rejectCommentRow(["comment", "share"], "reply");
  it("rejects a row with a reply control and no post marker", () => {
    const r = row(btn("sentinel-like"), btn("sentinel-reply"));
    expect(reject(r, sentinelReg)).toBe(true);
  });
  it("keeps a row where a post marker is present, even beside a reply", () => {
    const r = row(btn("sentinel-like"), btn("sentinel-reply"), btn("sentinel-share"));
    expect(reject(r, sentinelReg)).toBe(false);
  });
  it("keeps an unreadable row (no recognizable reply, no markers)", () => {
    const r = row(btn("zzz-unknown"), btn("yyy-unknown"));
    expect(reject(r, sentinelReg)).toBe(false);
  });
  it("a marker excluded from the list stops shielding the row", () => {
    // Instagram drops `comment` from its post markers - see isCommentRow in
    // instagram.ts: the comment-stemmed kebab must not read as a post marker.
    const noComment = rejectCommentRow(["share"], "reply");
    const r = row(btn("sentinel-comment"), btn("sentinel-reply"));
    expect(noComment(r, sentinelReg)).toBe(true);
  });
});

// The vocabulary half: the RU/UA labels captured live from comment rows must
// keep classifying as the stems the markers rely on. Single-element
// classification only - no row simulation.
describe("comment/reply label vocabulary (RU/UA)", () => {
  const stemReg = defineLabelRegistry({
    like: { exact: ["Like"], stems: STEM.like },
    comment: { exact: ["Comment"], stems: STEM.comment },
    share: { exact: ["Share"], stems: STEM.share },
    reply: { stems: STEM.reply },
  });
  it("classifies the RU/UA comment-actions kebab as comment-stemmed", () => {
    expect(stemReg.classify(btn("Действия с комментарием"))).toBe("comment");
    expect(stemReg.classify(btn("Параметри коментаря"))).toBe("comment");
  });
  it("classifies the RU/UA reply labels as reply", () => {
    expect(stemReg.classify(btn("Ответить"))).toBe("reply");
    expect(stemReg.classify(btn("Відповісти"))).toBe("reply");
  });
  it("classifies the RU post-bar labels as their post kinds", () => {
    expect(stemReg.classify(btn("Нравится"))).toBe("like");
    expect(stemReg.classify(btn("Комментировать"))).toBe("comment");
    expect(stemReg.classify(btn("Поделиться"))).toBe("share");
  });
});
