// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { ALL_SITE_MATCH_PATTERNS, detectSupportedSite, matchPatternsForSite, resolveSiteHomeUrl, SUPPORTED_SITES, targetUrlBelongsToSite, urlHostBelongsToSite } from "./sites";

describe("detectSupportedSite - explicit hosts", () => {
  it("maps every enumerated host to its site", () => {
    for (const s of SUPPORTED_SITES) {
      for (const host of s.hosts) {
        expect(detectSupportedSite(host)).toBe(s.site);
      }
    }
  });

  it("returns null for an unsupported host", () => {
    expect(detectSupportedSite("example.com")).toBeNull();
    expect(detectSupportedSite("notfacebook.com")).toBeNull();
  });
});

describe("detectSupportedSite - Amazon regional catch-all", () => {
  it("matches genuine regional Amazon TLDs not enumerated in hosts", () => {
    expect(detectSupportedSite("www.amazon.nl")).toBe("amazon");
    expect(detectSupportedSite("www.amazon.se")).toBe("amazon");
    expect(detectSupportedSite("www.amazon.com.tr")).toBe("amazon");
    expect(detectSupportedSite("www.amazon.co.za")).toBe("amazon");
  });

  it("rejects look-alike hosts that merely contain '.amazon.'", () => {
    // Regression for the release audit: the old `/\.amazon\./` substring regex
    // matched these; the anchored form must not.
    expect(detectSupportedSite("a.amazon.evil.com")).toBeNull();
    expect(detectSupportedSite("amazon.evil.com")).toBeNull();
    expect(detectSupportedSite("www.amazon.company.co")).toBeNull();
  });
});

describe("ALL_SITE_MATCH_PATTERNS", () => {
  it("never leaks the runtime-only Amazon regex into manifest globs", () => {
    for (const pattern of ALL_SITE_MATCH_PATTERNS) {
      expect(pattern).toMatch(/^https:\/\/[a-z0-9.-]+\/\*$/);
    }
  });
});

describe("urlHostBelongsToSite (parse-hosts, superset of run-hosts)", () => {
  it("defaults to the run hosts when no urlHosts override", () => {
    expect(urlHostBelongsToSite("github.com", "github")).toBe(true);
    expect(urlHostBelongsToSite("m.github.com", "github")).toBe(false);
    expect(urlHostBelongsToSite("www.instagram.com", "instagram")).toBe(true);
    expect(urlHostBelongsToSite("instagram.com", "instagram")).toBe(true);
  });

  it("accepts the declared superset for Facebook / YouTube", () => {
    // urlHosts is a superset of run-hosts: the bare `facebook.com` and
    // `m.youtube.com` are parse-only (the extension doesn't run on mobile
    // YouTube - `ytm-*` DOM), yet a link to either must still resolve.
    expect(urlHostBelongsToSite("facebook.com", "facebook")).toBe(true);
    expect(urlHostBelongsToSite("m.facebook.com", "facebook")).toBe(true);
    expect(urlHostBelongsToSite("m.youtube.com", "youtube")).toBe(true);
    expect(detectSupportedSite("m.youtube.com")).toBeNull();
  });

  it("is broader than the run-host contract (detectSupportedSite is narrower)", () => {
    // Bare facebook.com parses, but is NOT a run host.
    expect(detectSupportedSite("facebook.com")).toBeNull();
    expect(urlHostBelongsToSite("evil.example", "facebook")).toBe(false);
  });
});

describe("targetUrlBelongsToSite (the stored-target host gate)", () => {
  it("accepts what the adapters emit, including Amazon's regional storefronts", () => {
    expect(targetUrlBelongsToSite("https://github.com/owner/repo", "github")).toBe(true);
    expect(targetUrlBelongsToSite("https://www.reddit.com/r/x/comments/abc/", "reddit")).toBe(true);
    expect(targetUrlBelongsToSite("https://www.amazon.nl/dp/B01", "amazon")).toBe(true);
    // Parse-only host - an older exported history row can carry it.
    expect(targetUrlBelongsToSite("https://facebook.com/zuck/posts/1", "facebook")).toBe(true);
  });

  it("rejects an off-site, look-alike, or unparseable URL", () => {
    expect(targetUrlBelongsToSite("https://evil.example/owner/repo", "github")).toBe(false);
    expect(targetUrlBelongsToSite("https://github.com.evil.example/owner/repo", "github")).toBe(false);
    expect(targetUrlBelongsToSite("https://a.amazon.evil.com/dp/B01", "amazon")).toBe(false);
    // A URL on a supported site, but not the one it claims.
    expect(targetUrlBelongsToSite("https://github.com/owner/repo", "reddit")).toBe(false);
    expect(targetUrlBelongsToSite("not a url", "github")).toBe(false);
  });
});

describe("matchPatternsForSite", () => {
  it("derives a site's patterns from its descriptor hosts", () => {
    expect(matchPatternsForSite("github")).toEqual(["https://github.com/*"]);
    expect(matchPatternsForSite("youtube")).toEqual(["https://www.youtube.com/*", "https://youtube.com/*"]);
  });

  // LITERAL list, not re-derived via matchPatternsForSite: these patterns are
  // the manifest `content_scripts` contract, so a host-derivation regression
  // must fail here instead of co-mutating the expectation. Adding a site means
  // extending this list by hand - that is the point.
  it("unions to the exact manifest content_scripts pattern list", () => {
    expect([...ALL_SITE_MATCH_PATTERNS]).toEqual([
      "https://www.facebook.com/*",
      "https://m.facebook.com/*",
      "https://www.instagram.com/*",
      "https://instagram.com/*",
      "https://www.reddit.com/*",
      "https://reddit.com/*",
      "https://github.com/*",
      "https://gitlab.com/*",
      "https://www.youtube.com/*",
      "https://youtube.com/*",
      "https://x.com/*",
      "https://www.x.com/*",
      "https://threads.com/*",
      "https://www.threads.com/*",
      "https://www.amazon.com/*",
      "https://www.amazon.co.uk/*",
      "https://www.amazon.de/*",
      "https://www.amazon.fr/*",
      "https://www.amazon.it/*",
      "https://www.amazon.es/*",
      "https://www.amazon.ca/*",
      "https://www.amazon.com.au/*",
      "https://www.amazon.co.jp/*",
      "https://www.amazon.in/*",
      "https://www.amazon.com.br/*",
      "https://www.amazon.com.mx/*",
    ]);
  });
});

describe("resolveSiteHomeUrl", () => {
  it("returns the descriptor homeUrl for a single-domain site (no override)", () => {
    expect(resolveSiteHomeUrl("github", "github.com", "en-US")).toBe("https://github.com/");
    expect(resolveSiteHomeUrl("github", null, "de-DE")).toBe("https://github.com/");
  });

  it("Amazon prefers the active storefront host, normalising smile.* to .com", () => {
    expect(resolveSiteHomeUrl("amazon", "www.amazon.de", "en-US")).toBe("https://www.amazon.de/");
    // Retired host, so not a run host any more - but the regional catch-all still
    // matches it, and an old tab must not hand the popup a dead storefront link.
    expect(resolveSiteHomeUrl("amazon", "smile.amazon.com", "en-US")).toBe("https://www.amazon.com/");
    // Hosts only the anchored regional catch-all knows also count as storefronts.
    expect(resolveSiteHomeUrl("amazon", "www.amazon.nl", "en-US")).toBe("https://www.amazon.nl/");
    expect(resolveSiteHomeUrl("amazon", "amazon.co.uk", "en-US")).toBe("https://amazon.co.uk/");
  });

  it("Amazon never adopts a look-alike active host that merely contains 'amazon.'", () => {
    // Regression: the old unanchored /\.amazon\./ check adopted any host with
    // ".amazon." anywhere in it, handing the popup's Amazon link to an evil host.
    expect(resolveSiteHomeUrl("amazon", "a.amazon.evil.com", "en-US")).toBe("https://www.amazon.com/");
    expect(resolveSiteHomeUrl("amazon", "www.amazon.evil.com", "en-US")).toBe("https://www.amazon.com/");
    expect(resolveSiteHomeUrl("amazon", "amazon.evil.com", "en-GB")).toBe("https://www.amazon.co.uk/");
  });

  it("Amazon falls back to a language-mapped storefront, then .com", () => {
    expect(resolveSiteHomeUrl("amazon", null, "en-GB")).toBe("https://www.amazon.co.uk/");
    expect(resolveSiteHomeUrl("amazon", null, "de")).toBe("https://www.amazon.de/");
    expect(resolveSiteHomeUrl("amazon", null, "xx-YY")).toBe("https://www.amazon.com/");
  });
});
