// SPDX-License-Identifier: GPL-3.0-or-later
//
// The verdict half of the privacy detectors: plain strings in, a decision out. The DOM half
// (which element the string is read off) stays with the live e2e suites, per the rule in
// page-visibility.ts - nothing here constructs GitHub or GitLab markup.
//
// Both detectors gate the highest-consequence branch in the extension: a false negative mounts
// the trigger on a private repo and sends its name to the backend as a target.

import { describe, expect, it } from "vitest";
import { githubPrivateFromMeta, gitlabVisibilityFromIconHref, isPrivateGitlabVisibility } from "./page-visibility";

describe("githubPrivateFromMeta", () => {
  it("reads the two values GitHub stamps", () => {
    expect(githubPrivateFromMeta("false")).toBe(true);
    expect(githubPrivateFromMeta("true")).toBe(false);
  });

  it("says nothing when the tag is absent, so the caller falls back to the header", () => {
    expect(githubPrivateFromMeta(null)).toBeNull();
  });

  // The dangerous direction: an unrecognized value must NOT collapse to "public" and mount
  // the trigger. Anything but the literal `true` hands the decision to the lock/badge check.
  it("treats any other content as no answer rather than as public", () => {
    for (const content of ["", " ", "True", "TRUE", "1", "0", "yes", "public"]) {
      expect(githubPrivateFromMeta(content), `content=${JSON.stringify(content)}`).toBeNull();
    }
  });
});

describe("gitlabVisibilityFromIconHref", () => {
  it("names the visibility a sprite reference points at", () => {
    expect(gitlabVisibilityFromIconHref("/assets/icons-abc123.svg#earth")).toBe("earth");
    expect(gitlabVisibilityFromIconHref("/assets/icons-abc123.svg#lock")).toBe("lock");
    expect(gitlabVisibilityFromIconHref("/assets/icons-abc123.svg#shield")).toBe("shield");
  });

  it("accepts a suffixed sprite id - a renamed variant is still the same icon", () => {
    expect(gitlabVisibilityFromIconHref("/assets/icons.svg#lock-fill")).toBe("lock");
  });

  it("returns null for an href naming no visibility icon", () => {
    expect(gitlabVisibilityFromIconHref("")).toBeNull();
    expect(gitlabVisibilityFromIconHref("/assets/icons.svg")).toBeNull();
    expect(gitlabVisibilityFromIconHref("/assets/icons.svg#star-o")).toBeNull();
  });

  // `\b` is what stops this: a word character right after the name is not a boundary, so an
  // unrelated id that merely starts with one of the three does not borrow its meaning.
  it("does not match an id that only begins with a visibility name", () => {
    expect(gitlabVisibilityFromIconHref("/assets/icons.svg#earthquake")).toBeNull();
    expect(gitlabVisibilityFromIconHref("/assets/icons.svg#shielded")).toBeNull();
  });
});

describe("isPrivateGitlabVisibility", () => {
  it("counts `internal` as private - it is not anonymously viewable", () => {
    // The only check this verdict gets anywhere: every live e2e fixture is a PUBLIC project,
    // so no browser run can produce a #shield page.
    expect(isPrivateGitlabVisibility("shield")).toBe(true);
  });

  it("counts a members-only project as private and a public one as public", () => {
    expect(isPrivateGitlabVisibility("lock")).toBe(true);
    expect(isPrivateGitlabVisibility("earth")).toBe(false);
  });

  it("fails open when the icon said nothing", () => {
    expect(isPrivateGitlabVisibility(null)).toBe(false);
  });
});
