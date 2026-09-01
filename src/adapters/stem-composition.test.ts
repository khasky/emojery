// SPDX-License-Identifier: GPL-3.0-or-later
//
// Behavior guard for the action-label stems each adapter composes from the
// single `STEM_PARTS` vocabulary in action-labels.ts. Two invariants per adapter:
//   1. golden - the composed stem holds exactly the atomic alternatives pinned
//      below (copied from the pre-refactor inline regexes);
//   2. subset - it stays a subset of the shared STEM union, so a future edit can
//      narrow but never silently widen matching.
// Order-independent: a stem regex is compared as the SET of its top-level `|`
// alternatives - safe because no shared stem token contains a `|` inside a group.
import { describe, expect, it } from "vitest";
import { STEM, STEM_PARTS, stem } from "./action-labels";
import { FB_STEMS } from "./facebook";
import { IG_STEMS } from "./instagram";
import { X_STEMS } from "./x";

const atoms = (re: RegExp): Set<string> => new Set(re.source.split("|"));

function sameAtoms(actual: RegExp, goldenSource: string): void {
  expect([...atoms(actual)].sort()).toEqual([...goldenSource.split("|")].sort());
}

describe("stem composition reproduces each adapter's pre-refactor vocabulary", () => {
  it("X - full shared stems, repost without 'reshare'", () => {
    sameAtoms(X_STEMS.like, "\\b(?:un)?like(?:d)?\\b|нрав|подоба|вподоб|gefällt");
    sameAtoms(X_STEMS.reply, "\\breply\\b|ответ|відпов|antwort");
    sameAtoms(X_STEMS.repost, "\\brepost\\b|retweet|репост|ретвіт|поширит");
    sameAtoms(X_STEMS.bookmark, "\\bbookmark\\b|заклад|lesezeichen");
    sameAtoms(X_STEMS.share, "\\bshare\\b|подели|поділи|teilen");
  });

  it("Instagram - EN/RU/UA only (no German), narrowed repost", () => {
    sameAtoms(IG_STEMS.like, "\\b(?:un)?like(?:d)?\\b|нрав|подоба|вподоб");
    sameAtoms(IG_STEMS.comment, "\\bcomment\\b|комментир|комментар|коментув|коментар");
    sameAtoms(IG_STEMS.share, "\\bshare\\b|подели|поділи");
    sameAtoms(IG_STEMS.send, "\\bsend\\b|отправ|надісл|надсила|переслат");
    sameAtoms(IG_STEMS.repost, "\\brepost\\b|репост|поширит");
    sameAtoms(IG_STEMS.reply, "\\breply\\b|ответ|відпов|antwort");
  });

  it("Facebook - EN/RU/UA only (no German), reply marker without antwort", () => {
    sameAtoms(FB_STEMS.like, "\\b(?:un)?like(?:d)?\\b|нрав|подоба|вподоб");
    sameAtoms(FB_STEMS.comment, "\\bcomment\\b|комментир|комментар|коментув|коментар");
    sameAtoms(FB_STEMS.share, "\\bshare\\b|подели|поділи");
    sameAtoms(FB_STEMS.send, "\\bsend\\b|отправ|надісл|надсила|переслат");
    sameAtoms(FB_STEMS.reply, "\\breply\\b|ответ|відпов");
  });
});

// Behavioral subset: every live label an adapter's stem accepts, the shared
// STEM union must accept too - an adapter can narrow but never silently widen
// matching. Checked over a fixed corpus of real control labels (EN/RU/UA/DE,
// captured live) rather than by comparing regex source text, which could only
// fail on spelling, never on behavior.
// Known ceiling: a label outside this corpus escapes the check - extend the
// corpus when a locale is added.
const LIVE_LABELS = [
  "Like",
  "Liked",
  "Unlike",
  "Нравится",
  "Подобається",
  "Вподобання",
  "Gefällt mir",
  "Reply",
  "Ответить",
  "Відповісти",
  "Antwort",
  "Repost",
  "Retweet",
  "Репост",
  "Ретвіт",
  "Поширити",
  "Bookmark",
  "Закладки",
  "Lesezeichen",
  "Share",
  "Поделиться",
  "Поділитися",
  "Teilen",
  "Comment",
  "Комментировать",
  "Коментар",
  "Send",
  "Отправить",
  "Надіслати",
  "Переслати",
];

describe("each adapter stem behaves as a subset of the shared STEM union", () => {
  // STEM carries no repost union (adapters compose their own subsets), so the
  // full-vocabulary union for the subset check is rebuilt from STEM_PARTS here.
  const UNION: Record<string, RegExp> = { ...STEM, repost: stem(...Object.values(STEM_PARTS.repost)) };
  const ADAPTER_STEMS: Array<[string, Partial<Record<keyof typeof UNION, RegExp>>]> = [
    ["X", X_STEMS],
    ["Instagram", IG_STEMS],
    ["Facebook", FB_STEMS],
  ];

  it.each(ADAPTER_STEMS)("%s: no label matched by the adapter is rejected by the union", (_name, stems) => {
    for (const [kind, stem] of Object.entries(stems) as Array<[string, RegExp]>) {
      const union = UNION[kind];
      expect(union, `${kind}: adapter composes a stem the shared vocabulary does not know`).toBeDefined();
      if (!union) continue;
      for (const label of LIVE_LABELS) {
        if (stem.test(label)) {
          expect(union.test(label), `${kind}: adapter matches "${label}" but the shared STEM union does not`).toBe(true);
        }
      }
    }
  });
});
