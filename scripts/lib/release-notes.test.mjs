// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The body every GitHub release is published with, so a mistake here is only visible after the tag exists.
import { describe, expect, it } from "vitest";
import { buildReleaseNotes } from "./release-notes.mjs";

const changelog = [
  "# Changelog",
  "",
  "## [0.1.3](https://github.com/khasky/emojery/compare/v0.1.2...v0.1.3) (2026-07-18)",
  "",
  "### Features",
  "",
  "* **popup:** show build version ([553002c](https://github.com/khasky/emojery/commit/553002c))",
  "",
  "## [0.1.2](https://github.com/khasky/emojery/compare/v0.1.1...v0.1.2) (2026-07-15)",
  "",
  "## 0.1.0 (2026-07-05)",
  "",
  "### Features",
  "",
  "* initial release ([d3a7e51](https://github.com/khasky/emojery/commit/d3a7e51))",
].join("\n");

describe("buildReleaseNotes", () => {
  it("slices only the requested version and re-appends its compare link", () => {
    const notes = buildReleaseNotes(changelog, "0.1.3");

    expect(notes).toContain("**popup:** show build version");
    expect(notes).not.toContain("initial release");
    expect(notes).toMatch(/\*\*Full Changelog\*\*: https:\/\/github\.com\/khasky\/emojery\/compare\/v0\.1\.2\.\.\.v0\.1\.3$/);
  });

  it("names the reason when every commit in the version was a hidden type", () => {
    const notes = buildReleaseNotes(changelog, "0.1.2");

    expect(notes).toContain("No changelog-visible changes");
    expect(notes).toContain("/compare/v0.1.1...v0.1.2");
  });

  it("omits the footer for a first release, whose heading has no compare link", () => {
    const notes = buildReleaseNotes(changelog, "0.1.0");

    expect(notes).toContain("initial release");
    expect(notes).not.toContain("Full Changelog");
  });

  it("does not take a longer version's section for a prefix of it", () => {
    const withPatch30 = changelog.replace("## [0.1.3](", "## [0.1.30](");

    expect(buildReleaseNotes(withPatch30, "0.1.3")).toBe("See CHANGELOG.md for changes in 0.1.3.");
  });

  it("falls back to the changelog pointer for a version it cannot find", () => {
    expect(buildReleaseNotes(changelog, "9.9.9")).toBe("See CHANGELOG.md for changes in 9.9.9.");
  });
});
