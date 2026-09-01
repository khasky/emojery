// SPDX-License-Identifier: GPL-3.0-or-later
//
// Exercises the English fallback path (chrome.i18n is undefined under Vitest),
// pinned against real keys in the shipped en catalog.
//
// The multi-placeholder case is the one worth pinning: Chrome substitutes by the
// `content: "$1"` / `"$2"` index each placeholder declares, while this fallback
// substitutes in the order the placeholders appear in the message text. The two
// agree only while a message's textual order matches its declared indexes, and
// nothing but this test says so - a message written `$SECOND$ ... $FIRST$` with
// `content: "$2"` / `"$1"` would read correctly in the browser and swapped here.
import { describe, expect, it } from "vitest";
import { type I18nKey, t } from "./i18n";

describe("t", () => {
  it("returns the English message for a known key", () => {
    expect(t("extName")).toBe("Emojery");
  });

  it("substitutes a single string into the placeholder", () => {
    expect(t("authCodeTagline", "a@b.example")).toBe("We sent a code to a@b.example. It expires in 10 minutes.");
  });

  it("applies array substitutions in order; extras are ignored", () => {
    expect(t("authResendInBtn", ["0:30", "9:99"])).toBe("Resend code in 0:30");
  });

  it("fills a two-placeholder message in the order the text declares them", () => {
    expect(t("onboardingProgress", ["2", "4"])).toBe("2 of 4 done");
    expect(t("importReplaceCountAria", ["128", "64"])).toBe("Saved reactions: 128. In this file: 64.");
  });

  it("leaves the placeholder literal when no substitutions are given", () => {
    expect(t("authResendInBtn")).toBe("Resend code in $TIME$");
  });

  it("ignores substitutions on a placeholder-free message", () => {
    expect(t("extName", "unused")).toBe("Emojery");
  });

  it("falls back to the key itself for an unknown key", () => {
    expect(t("definitelyNotAKey" as I18nKey)).toBe("definitelyNotAKey");
  });
});
