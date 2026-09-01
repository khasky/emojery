// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { isOwnHomepage } from "./homepage";

describe("isOwnHomepage - the extension's own homepage", () => {
  it("matches the homepage on any path", () => {
    expect(isOwnHomepage("https://emojery.app/")).toBe(true);
    expect(isOwnHomepage("https://emojery.app/roadmap")).toBe(true);
  });

  it("ignores subdomains, look-alikes and unreadable urls", () => {
    expect(isOwnHomepage("https://api.emojery.app/")).toBe(false);
    expect(isOwnHomepage("https://notemojery.app/")).toBe(false);
    expect(isOwnHomepage(undefined)).toBe(false);
    expect(isOwnHomepage("not a url")).toBe(false);
  });
});
