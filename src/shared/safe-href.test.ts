// SPDX-License-Identifier: GPL-3.0-or-later
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HOSTILE_STRINGS } from "../test/hostile-inputs";
import { safeHttpHref } from "./safe-href";

describe("safeHttpHref", () => {
  it("passes through http(s) URLs", () => {
    expect(safeHttpHref("https://www.facebook.com/zuck/posts/1")).toBe("https://www.facebook.com/zuck/posts/1");
    expect(safeHttpHref("http://example.com/")).toBe("http://example.com/");
  });

  it("rejects non-http(s) schemes so they never become a clickable href", () => {
    expect(safeHttpHref("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpHref("data:text/html,<script>alert(1)</script>")).toBeUndefined();
    expect(safeHttpHref("blob:https://example.com/uuid")).toBeUndefined();
    expect(safeHttpHref("chrome-extension://abc/auth.html")).toBeUndefined();
  });

  it("rejects unparseable input", () => {
    expect(safeHttpHref("not a url")).toBeUndefined();
    expect(safeHttpHref("")).toBeUndefined();
  });

  // This is the last thing between a stored target URL and an `<a href>` in the popup, so the
  // guarantee has to hold for every string, not only the schemes anyone listed. The shared
  // corpus runs first; the generator then hunts for whatever it does not contain.
  it("returns nothing but an http(s) URL, for any input at all", () => {
    const holds = (raw: string) => {
      const href = safeHttpHref(raw);
      if (href === undefined) return;
      expect(href, raw).toMatch(/^https?:\/\//);
      // And it stays that way after a re-parse - the value is handed on as a URL, not as text.
      expect(new URL(href).protocol, raw).toMatch(/^https?:$/);
    };

    for (const raw of HOSTILE_STRINGS) holds(raw);
    fc.assert(fc.property(fc.oneof(fc.string(), fc.webUrl(), fc.constantFrom(...HOSTILE_STRINGS)), holds), { numRuns: 500 });
  });

  it("still lets ordinary web URLs through, so the property above is not vacuous", () => {
    let accepted = 0;
    fc.assert(
      fc.property(fc.webUrl(), (url) => {
        if (safeHttpHref(url) !== undefined) accepted += 1;
      }),
    );
    expect(accepted).toBeGreaterThan(0);
  });
});
