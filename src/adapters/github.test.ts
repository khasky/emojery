// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import githubAdapter, { findListItemWithin, githubStarLabelPressed, isListItemWithin, repoRefFromPathname } from "./github";
import { expectMatchesRegistryHosts } from "./test-fixtures";

describe("github adapter", () => {
  it("matches github.com host only", () => {
    expectMatchesRegistryHosts(githubAdapter, "github");
    expect(githubAdapter.matches("api.github.com")).toBe(false);
    expect(githubAdapter.matches("gist.github.com")).toBe(false);
  });
});

// Auto-press pressed-state read: the aria-label is the ONE signal that flips on
// the 2025 Primer header ("Star owner/repo" <-> "Unstar owner/repo").
describe("githubStarLabelPressed", () => {
  it("reads the flipped label as pressed", () => {
    expect(githubStarLabelPressed("Unstar torvalds/linux")).toBe(true);
    expect(githubStarLabelPressed("unstar this repository")).toBe(true);
  });

  it("reads the resting label as unpressed", () => {
    expect(githubStarLabelPressed("Star torvalds/linux")).toBe(false);
    expect(githubStarLabelPressed("star this repository")).toBe(false);
  });

  it("stays unknown on any other label - unknown must never press", () => {
    expect(githubStarLabelPressed("")).toBeNull();
    expect(githubStarLabelPressed("Starred")).toBeNull();
    expect(githubStarLabelPressed("Unwatch torvalds/linux")).toBeNull();
    expect(githubStarLabelPressed("Sponsor torvalds")).toBeNull();
  });

  // GitHub ships a localized UI (ja/zh/ko/pt-BR/...), where the Star label
  // shares no substring with the English one. The read then answers UNKNOWN and
  // auto-press declines - the feature is silently unavailable there, which is
  // the safe half of the trade: a wrong `false` would star the repo unasked.
  // Upgrade path: read the button's own state (icon fill / octicon name), not
  // its label, the way the GitLab reader already does.
  it("stays unknown on a localized GitHub UI rather than guessing", () => {
    for (const label of ["torvalds/linux にスターを付ける", "torvalds/linux のスターを外す", "为 torvalds/linux 加星标", "取消收藏 torvalds/linux", "torvalds/linux 스타"]) {
      expect(githubStarLabelPressed(label), label).toBeNull();
    }
  });
});

describe("repoRefFromPathname", () => {
  it("derives owner/repo from a repo-root path", () => {
    expect(repoRefFromPathname("/torvalds/linux")).toEqual({ owner: "torvalds", repo: "linux" });
    expect(repoRefFromPathname("/torvalds/linux/")).toEqual({ owner: "torvalds", repo: "linux" });
  });

  it("rejects one-segment paths", () => {
    expect(repoRefFromPathname("/torvalds")).toBeNull();
    expect(repoRefFromPathname("/")).toBeNull();
  });

  it("rejects deeper paths - a repo subpage is not the repo home", () => {
    expect(repoRefFromPathname("/torvalds/linux/issues")).toBeNull();
    expect(repoRefFromPathname("/torvalds/linux/tree/master")).toBeNull();
  });

  it("rejects site-level reserved routes", () => {
    expect(repoRefFromPathname("/settings/profile")).toBeNull();
    expect(repoRefFromPathname("/orgs/community")).toBeNull();
    expect(repoRefFromPathname("/notifications/subscriptions")).toBeNull();
  });

  it("rejects a reserved route whatever case the link spelled it in", () => {
    // GitHub routes owners case-insensitively, so /Settings/profile serves the
    // settings page, not a repo owned by "Settings".
    expect(repoRefFromPathname("/Settings/profile")).toBeNull();
    expect(repoRefFromPathname("/ORGS/community")).toBeNull();
  });
});

// Generic sentinel elements (no fake supported-site DOM): the action-list walk
// backing findActionListItem / isActionListItem. Live GitHub placement is
// verified by e2e.
describe("findListItemWithin / isListItemWithin", () => {
  function listWithItem(): { item: HTMLElement; leaf: HTMLElement } {
    const list = document.createElement("ul");
    list.className = "the-list";
    const item = document.createElement("li");
    const leaf = document.createElement("span");
    item.appendChild(leaf);
    list.appendChild(item);
    document.body.appendChild(list);
    return { item, leaf };
  }

  it("walks up to the LI whose parent matches the scope selectors", () => {
    const { item, leaf } = listWithItem();
    expect(findListItemWithin(leaf, [".the-list"], 3)).toBe(item);
    expect(isListItemWithin(item, [".the-list"])).toBe(true);
  });

  it("rejects an LI in a foreign list and respects the depth cap", () => {
    const { item, leaf } = listWithItem();
    expect(findListItemWithin(leaf, [".other-list"], 3)).toBeNull();
    expect(isListItemWithin(item, [".other-list"])).toBe(false);
    expect(findListItemWithin(leaf, [".the-list"], 0)).toBeNull();
  });
});
