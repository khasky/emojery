// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { normalizeLanguageTag } from "./language-tag";

describe("normalizeLanguageTag", () => {
  it("passes valid BCP-47 tags through", () => {
    expect(normalizeLanguageTag("en")).toBe("en");
    expect(normalizeLanguageTag("en-US")).toBe("en-US");
    expect(normalizeLanguageTag("zh-Hant-TW")).toBe("zh-Hant-TW");
  });

  it("normalizes underscores and surrounding whitespace", () => {
    expect(normalizeLanguageTag("en_US")).toBe("en-US");
    expect(normalizeLanguageTag("  en-GB  ")).toBe("en-GB");
  });

  it("rejects non-strings", () => {
    expect(normalizeLanguageTag(undefined)).toBeUndefined();
    expect(normalizeLanguageTag(null)).toBeUndefined();
    expect(normalizeLanguageTag(42)).toBeUndefined();
  });

  it("rejects malformed tags", () => {
    expect(normalizeLanguageTag("")).toBeUndefined();
    expect(normalizeLanguageTag("a".repeat(36))).toBeUndefined();
    expect(normalizeLanguageTag("e")).toBeUndefined();
    expect(normalizeLanguageTag("en-")).toBeUndefined();
    expect(normalizeLanguageTag("en--US")).toBeUndefined();
    expect(normalizeLanguageTag("123")).toBeUndefined();
    expect(normalizeLanguageTag("en US")).toBeUndefined();
  });
});
