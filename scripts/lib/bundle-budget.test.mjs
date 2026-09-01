// SPDX-License-Identifier: GPL-3.0-or-later
//
// Both boundaries the content-script weight gate rests on. The gate runs only after a build and
// prints the same line either side of each limit, so a drift in the comparison is invisible
// until a store review - this pins it. Every number comes from the module the gate itself
// imports: a local copy would keep passing after the shipped limit moved.
import { describe, expect, it } from "vitest";
import { contentScriptIssues, DISTINCTIVE_MESSAGE_LENGTH, distinctiveMessages, BUNDLE_LIMITS as LIMITS } from "./bundle-budget.mjs";

const bundle = (over = {}) => ({ name: "github.js", bytes: 1_000, inlined: 0, ...over });

describe("contentScriptIssues", () => {
  it("passes a bundle inside both limits", () => {
    expect(contentScriptIssues(bundle(), LIMITS)).toEqual([]);
  });

  // Strict `>`: a bundle ON the ceiling is within budget. Either direction of drift here is
  // silent - one lets growth through, the other fails a build that changed nothing.
  it("allows exactly the byte budget and rejects one byte more", () => {
    expect(contentScriptIssues(bundle({ bytes: LIMITS.maxBytes }), LIMITS)).toEqual([]);
    expect(contentScriptIssues(bundle({ bytes: LIMITS.maxBytes + 1 }), LIMITS)).toHaveLength(1);
  });

  it("allows exactly the inlined-message ceiling and rejects one more", () => {
    expect(contentScriptIssues(bundle({ inlined: LIMITS.maxDistinctive }), LIMITS)).toEqual([]);
    expect(contentScriptIssues(bundle({ inlined: LIMITS.maxDistinctive + 1 }), LIMITS)).toHaveLength(1);
  });

  it("reports both problems at once rather than stopping at the first", () => {
    expect(contentScriptIssues(bundle({ bytes: LIMITS.maxBytes * 5, inlined: LIMITS.maxDistinctive * 80 }), LIMITS)).toHaveLength(2);
  });

  it("names the bundle and the limit in each message, since the log is the whole report", () => {
    const [tooBig] = contentScriptIssues(bundle({ bytes: LIMITS.maxBytes + 1 }), LIMITS);
    expect(tooBig).toContain("github.js");
    expect(tooBig).toContain(String(LIMITS.maxBytes));

    const [dictionary] = contentScriptIssues(bundle({ inlined: LIMITS.maxDistinctive * 8 }), LIMITS);
    expect(dictionary).toContain("__EM_I18N_FALLBACK__");
  });
});

describe("distinctiveMessages", () => {
  const dictionary = {
    short: { message: "Search" },
    long: { message: "Turn every Like button into a full emoji palette" },
    exact: { message: "x".repeat(DISTINCTIVE_MESSAGE_LENGTH) },
    justUnder: { message: "x".repeat(DISTINCTIVE_MESSAGE_LENGTH - 1) },
    empty: {},
  };

  it("keeps messages at or past the length bound and drops the rest", () => {
    expect(distinctiveMessages(dictionary, DISTINCTIVE_MESSAGE_LENGTH).sort()).toEqual([dictionary.exact.message, dictionary.long.message].sort());
  });

  it("survives an entry with no message instead of throwing", () => {
    expect(distinctiveMessages({ broken: {} }, 1)).toEqual([]);
  });

  // The gate exits 1 on an empty list rather than passing vacuously; this is the input that
  // would produce one, so the behaviour above it stays reachable.
  it("returns nothing when no message is long enough", () => {
    expect(distinctiveMessages(dictionary, 1_000)).toEqual([]);
  });
});
