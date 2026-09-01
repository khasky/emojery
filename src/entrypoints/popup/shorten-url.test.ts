// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { shortenUrl } from "./shorten-url";

describe("shortenUrl", () => {
  it("drops only the protocol, keeping host + path + query", () => {
    expect(shortenUrl("https://github.com/torvalds/linux")).toBe("github.com/torvalds/linux");
    expect(shortenUrl("https://www.facebook.com/photo/?fbid=123")).toBe("www.facebook.com/photo/?fbid=123");
  });

  it("drops the fragment", () => {
    expect(shortenUrl("https://example.com/a?b=1#frag")).toBe("example.com/a?b=1");
  });

  it("keeps long URLs whole - width truncation is CSS's job", () => {
    const path = `/x/${"a".repeat(200)}`;
    expect(shortenUrl(`https://example.com${path}`)).toBe(`example.com${path}`);
  });

  it("returns a non-URL string unchanged", () => {
    expect(shortenUrl("not a url")).toBe("not a url");
    expect(shortenUrl("")).toBe("");
  });
});
