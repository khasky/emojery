// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import gitlabAdapter, { extractGitLabProjectRef, gitlabStarIconPressed } from "./gitlab";
import { expectMatchesRegistryHosts } from "./test-fixtures";

const PROJECT_PATH = "gitlab-org/gitlab";
const PROJECT_URL = `https://gitlab.com/${PROJECT_PATH}`;

describe("gitlab adapter", () => {
  it("matches gitlab.com only", () => {
    expectMatchesRegistryHosts(gitlabAdapter, "gitlab");
    expect(gitlabAdapter.matches("www.gitlab.com")).toBe(false);
    expect(gitlabAdapter.matches("github.com")).toBe(false);
  });

  it("extracts canonical project refs from project and action links", () => {
    expect(extractGitLabProjectRef(`${PROJECT_URL}/-/starrers`)).toEqual({
      path: PROJECT_PATH,
      url: PROJECT_URL,
    });
    expect(extractGitLabProjectRef(`${PROJECT_URL}/-/tree/main`)).toEqual({
      path: PROJECT_PATH,
      url: PROJECT_URL,
    });
    expect(extractGitLabProjectRef(PROJECT_URL)).toEqual({
      path: PROJECT_PATH,
      url: PROJECT_URL,
    });
    expect(extractGitLabProjectRef("https://example.com/a/b")).toBeNull();
    expect(extractGitLabProjectRef("https://gitlab.com/explore")).toBeNull();
  });
});

// Auto-press pressed-state read: per star_count.vue the ICON is the only
// locale-independent signal - `star-o` outline unstarred, filled `star` starred.
describe("gitlabStarIconPressed", () => {
  it("maps the star_count.vue icon pair", () => {
    expect(gitlabStarIconPressed("star")).toBe(true);
    expect(gitlabStarIconPressed("star-o")).toBe(false);
  });

  it("stays unknown on any other icon - unknown must never press", () => {
    expect(gitlabStarIconPressed(null)).toBeNull();
    expect(gitlabStarIconPressed("")).toBeNull();
    expect(gitlabStarIconPressed("star-half")).toBeNull();
    expect(gitlabStarIconPressed("fork")).toBeNull();
  });
});

// The button-group walk backing resolveButtonGroup is the shared
// runtime.closestWithin; its cases live in runtime.test.ts.
