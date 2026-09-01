// SPDX-License-Identifier: GPL-3.0-or-later
import { readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import instagramAdapter, { COMMENT_MENU_STEM, COUNTER_LOCALES, extractInstagramShortcode, igLikeIconPressed, igLikeLabelPressed, isBareCountText, isStandaloneLikeCountText } from "./instagram";
import { expectMatchesRegistryHosts } from "./test-fixtures";

const LOCALES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/_locales");

const POST_CODE = "DYUhRl8OWQU";
const PROFILE_POST_CODE = "DWrhvc1jbX1";
const REEL_CODE = "DWoM2GeDWg-";

describe("instagram adapter", () => {
  it("matches instagram hosts only", () => {
    expectMatchesRegistryHosts(instagramAdapter, "instagram");
    expect(instagramAdapter.matches("m.instagram.com")).toBe(false);
    expect(instagramAdapter.matches("facebook.com")).toBe(false);
  });

  it("extracts post and reel shortcodes", () => {
    expect(extractInstagramShortcode(`https://www.instagram.com/p/${POST_CODE}/`)).toMatchObject({ kind: "p", shortcode: POST_CODE });
    expect(extractInstagramShortcode(`https://www.instagram.com/ikkywatari/p/${PROFILE_POST_CODE}/`)).toMatchObject({ kind: "p", shortcode: PROFILE_POST_CODE });
    expect(extractInstagramShortcode(`https://instagram.com/reel/${REEL_CODE}/?utm_source=ig_web_copy_link`)).toMatchObject({ kind: "reel", shortcode: REEL_CODE });
    expect(extractInstagramShortcode("https://example.com/p/not-instagram/")).toBeNull();
  });

  // The immersive reel viewer uses the PLURAL `/reels/<sc>/` URL while the
  // permalink is the SINGULAR `/reel/<sc>/`; both must converge on one target so
  // a reaction follows the reel across surfaces. `/reels/audio/<id>/` is the
  // audio page, not a reel.
  it("normalizes the plural /reels/ viewer URL to the canonical /reel/ target", () => {
    const plural = extractInstagramShortcode(`https://www.instagram.com/reels/${REEL_CODE}/`);
    expect(plural).toMatchObject({ kind: "reel", shortcode: REEL_CODE });
    const singular = extractInstagramShortcode(`https://www.instagram.com/reel/${REEL_CODE}/`);
    expect(plural).toEqual(singular);
    expect(extractInstagramShortcode("https://www.instagram.com/reels/audio/123456/")).toBeNull();
    expect(extractInstagramShortcode("https://www.instagram.com/reels/")).toBeNull();
  });

  // Coverage guard: COUNTER_LOCALES hand-mirrors the shipped locale folders
  // (Intl takes BCP-47 `pt-BR` where the folder is `pt_BR`). Shipping a new
  // locale without listing it here leaves that UI's compact suffix unmatched -
  // the like count then stays visible beside the trigger under replace-native.
  it("covers every shipped locale in public/_locales", () => {
    const shipped = readdirSync(LOCALES_DIR)
      .filter((entry) => statSync(resolve(LOCALES_DIR, entry)).isDirectory())
      .map((entry) => entry.replace("_", "-"))
      .sort();
    expect([...COUNTER_LOCALES].sort(), "COUNTER_LOCALES must list exactly the locales in public/_locales").toEqual(shipped);
  });

  // Regression pin: the Cyrillic atoms once carried `\b`, which is ASCII-only
  // in JS regexes - `\bопци` can never match "Опции", so RU/UA kebab menus
  // slipped past the reject list.
  describe("COMMENT_MENU_STEM - comment-kebab menu labels", () => {
    it("matches EN/RU/UA menu labels", () => {
      for (const label of ["Comment Options", "More options", "Настройки", "Параметры", "Опции", "Опції", "Налаштування", "Дополнительно", "Додатково"]) {
        expect(label, label).toMatch(COMMENT_MENU_STEM);
      }
    });

    it("matches no post action label", () => {
      for (const label of ["Like", "Comment", "Share", "Нравится", "Комментировать", "Поделиться", "Вподобати", "Коментувати", "Поділитися"]) {
        expect(label, label).not.toMatch(COMMENT_MENU_STEM);
      }
    });
  });

  // The like counter's compact-magnitude suffix is localized per IG UI language;
  // an unmatched suffix left the reels-feed count visible beside the trigger
  // while replace-native had hidden its heart. The suffix set is generated from
  // Intl (CLDR) for every locale the extension ships - assert a spread of
  // scripts, plus the plain grouped forms that must keep matching.
  describe("isBareCountText - localized compact counts", () => {
    it("matches plain and grouped counts", () => {
      for (const text of ["12", "11 490", "4,483", "1.234", "327 555"]) {
        expect(isBareCountText(text), text).toBe(true);
      }
    });

    it("matches compact suffixes across shipped locales", () => {
      for (const text of ["1.2K", "41 тыс.", "41 тыс", "2,1 млн", "5 тис.", "1,2 Mio.", "3 mln", "1.2万", "2億"]) {
        expect(isBareCountText(text), text).toBe(true);
      }
    });

    // CJK magnitudes are their own numeral system (万 = 10^4, 億 = 10^8) and
    // zh-TW writes 萬 where zh-CN writes 万 - a suffix table built from Latin/
    // Cyrillic abbreviations alone would leave the count visible next to the
    // trigger under replace-native on every CJK UI.
    it("matches the CJK magnitude suffixes, including the zh-TW form", () => {
      for (const text of ["1.2万", "12.3萬", "2億", "3,4万", "1兆"]) {
        expect(isBareCountText(text), text).toBe(true);
      }
    });

    it("rejects non-count text", () => {
      for (const text of ["", "нравится", "отметки", "3 часа назад", "peace", "1 million dollars idea"]) {
        expect(isBareCountText(text), text).toBe(false);
      }
    });
  });

  describe("isStandaloneLikeCountText - the like-count line", () => {
    it("keeps the exact EN form and accepts localized like-word tails", () => {
      for (const text of ["1,234 likes", "1 like", '2 534 отметки "Нравится"', '41 тыс. отметок "Нравится"', "2 534 вподобання"]) {
        expect(isStandaloneLikeCountText(text), text).toBe(true);
      }
    });

    it("rejects captions and timestamps", () => {
      for (const text of ["I like 100 dogs and this is a long caption", "100 likes for my dog? come on everyone", "3 часа назад", "16 hours ago"]) {
        expect(isStandaloneLikeCountText(text), text).toBe(false);
      }
    });
  });
});

// Auto-press liked-state read: IG ships EN/RU/UA, and the RU unlike label
// CONTAINS the like stem («Не нравится») - the negation must win before the
// stem is consulted.
describe("igLikeLabelPressed", () => {
  it("reads the unlike label as pressed in every shipped locale", () => {
    expect(igLikeLabelPressed("Unlike")).toBe(true);
    expect(igLikeLabelPressed("Не нравится")).toBe(true);
    expect(igLikeLabelPressed("Не подобається")).toBe(true);
  });

  it("reads the like label as unpressed in every shipped locale", () => {
    expect(igLikeLabelPressed("Like")).toBe(false);
    expect(igLikeLabelPressed("Нравится")).toBe(false);
    expect(igLikeLabelPressed("Подобається")).toBe(false);
  });

  it("stays unknown on missing or foreign labels - unknown must never press", () => {
    expect(igLikeLabelPressed("")).toBeNull();
    expect(igLikeLabelPressed("Comment")).toBeNull();
    expect(igLikeLabelPressed("Gefällt mir")).toBeNull();
  });

  // Instagram localizes far beyond the EN/RU/UA the stems cover. A CJK/Korean
  // label must read UNKNOWN (auto-press declines) and never `false`, which
  // would like the post unasked - and never `true`, which would leave a real
  // like standing while we believe we removed it.
  it("stays unknown on CJK/Korean labels rather than guessing", () => {
    for (const label of ["いいね！", "「いいね！」を取り消す", "赞", "取消赞", "說讚", "좋아요"]) {
      expect(igLikeLabelPressed(label), label).toBeNull();
    }
  });
});

// The language-independent half of the same read. The CJK labels above are
// UNKNOWN to the stems, so on those locales the icon is the only signal
// auto-press has; these are the live-captured heart paths.
describe("igLikeIconPressed", () => {
  const IDLE_HEART = "M16.792 3.904A4.989 4.989 0 0 1 21.5 9.122c0 3.072-2.652 4.959-5.197 7.222";
  const FILLED_HEART = "M34.6 3.1c-4.5 0-7.9 1.8-10.6 5.6-2.7-3.7-6.1-5.5-10.6-5.5C6 3.1 0 9.6 0 17.6";

  it("reads the filled heart as pressed and the outline heart as unpressed", () => {
    expect(igLikeIconPressed(FILLED_HEART)).toBe(true);
    expect(igLikeIconPressed(IDLE_HEART)).toBe(false);
  });

  it("stays unknown on any other icon - unknown must never press", () => {
    expect(igLikeIconPressed("")).toBeNull();
    expect(igLikeIconPressed("M20.656 17.008a9.993 9.993 0 1 0-3.59 3.615L22 22Z")).toBeNull();
  });
});
