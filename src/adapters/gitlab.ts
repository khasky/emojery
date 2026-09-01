// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryAll, queryFirst } from "../shared/dom-query";
import { defineSiteAdapter } from "./framework";
import { isPrivateGitlabProjectPage } from "./page-visibility";
import { findFirstAnchor, findSiblingAction } from "./placement";
import { closestWithin } from "./runtime";
import { parseSiteHref, pathSegments } from "./url-target";

const ACTION_CONTAINER_SELECTORS = [".project-home-panel .project-repo-buttons", "header.project-home-panel .project-repo-buttons"];
const STAR_CONTROL_SELECTORS = ['[data-testid="star-button"]', '[data-testid="star-count"]', ".project-repo-buttons .star-btn", ".project-repo-buttons .star-count", 'a[href$="/-/starrers"]', 'button[title*="star" i]', 'a[title*="star" i]'];
const MORE_BUTTON_SELECTORS = ["#project-more-action-dropdown"];
const FORK_BUTTON_SELECTORS = ['[data-testid="fork-button"]', '[data-testid="forks-count"]', 'a[href*="/-/forks"]'];
const PROJECT_ID_SELECTORS = ['[data-testid="project-id-content"]', '[itemprop="identifier"]'];
const BUTTON_GROUP_CLASS_SELECTOR = ".gl-button-group.btn-group";
const BUTTON_GROUP_SELECTOR = `div[role="group"]${BUTTON_GROUP_CLASS_SELECTOR}`;
const STAR_BUTTON_SELECTORS = ['button[data-testid="star-button"]', "button.star-btn", 'button[title*="star" i]'];

// Pressed-state read for auto-press: nothing readPressed looks at flips on
// GitLab's star button (no `aria-pressed`, no form, `data-testid` stays
// `star-button` in both states). Per star_count.vue only the ICON is usable -
// `star-o` outline unstarred, filled `star` starred - rendered by `gl-icon` as
// `<svg data-testid="<name>-icon"><use href="...#<name>">`. Any other name reads
// UNKNOWN (null) - the likePressed contract in shared/adapter.ts.
export function gitlabStarIconPressed(name: string | null): boolean | null {
  if (name === "star") return true;
  if (name === "star-o") return false;
  return null;
}

function gitlabStarPressed(btn: HTMLElement): boolean | null {
  return gitlabStarIconPressed(gitlabIconName(btn));
}

export function gitlabIconName(btn: HTMLElement): string | null {
  const testId = btn.querySelector('svg[data-testid$="-icon"]')?.getAttribute("data-testid");
  if (testId) return testId.replace(/-icon$/, "");
  return btn.querySelector("use")?.getAttribute("href")?.split("#")[1] ?? null;
}

const gitlabAdapter = defineSiteAdapter({
  site: "gitlab",
  // Never react on a private/internal project, even when a member can see it:
  // the project-header visibility icon reads `#lock`/`#shield` instead of `#earth`.
  isPrivatePage: ({ root }) => isPrivateGitlabProjectPage(root),
  // Candidate = the first action-row container that holds a Star control
  // (resolveBinding re-derives the control + its button group inside it).
  findCandidates: ({ root }) => {
    const container = findFirstAnchor(root, [
      {
        selectors: ACTION_CONTAINER_SELECTORS,
        accept: (c) => (queryFirst<HTMLElement>(c, STAR_CONTROL_SELECTORS) ? c : null),
      },
    ]);
    return container ? [container] : [];
  },
  resolveTarget: (_container, { root }) => extractProjectTarget(root),
  resolveBinding: (container) => {
    const control = queryFirst<HTMLElement>(container, STAR_CONTROL_SELECTORS);
    if (!control) return null;
    const group = resolveButtonGroup(control);
    // Prefer mounting before the More-actions / Fork action so the picker
    // sits inline in the button row; otherwise fall back to after the group.
    const placementAnchor = findPlacementAnchor(container);
    // Auto-press needs the real Star <button>; signed out the control is a
    // starrers <a> - pressing that would navigate, so only a BUTTON qualifies.
    const starButton = queryFirst<HTMLElement>(container, STAR_BUTTON_SELECTORS);
    return {
      anchor: placementAnchor ?? group,
      position: placementAnchor ? "before" : "after",
      nativeElement: group,
      replaceElement: group,
      ...(starButton ? { nativeVote: { like: starButton, likePressed: () => gitlabStarPressed(starButton) } } : {}),
    };
  },
  // GitLab navigates in-page via Turbo (turbo:load / turbo:render).
  observer: {
    debounceMs: 200,
    navKey: "pathname",
    triggerEvents: ["turbo:load", "turbo:render"],
  },
});

function findPlacementAnchor(container: HTMLElement): HTMLElement | null {
  return findSiblingAction(container, [
    { selectors: MORE_BUTTON_SELECTORS, resolve: (el) => el },
    { selectors: FORK_BUTTON_SELECTORS, resolve: (el) => resolveButtonGroup(el) },
  ]);
}

// How far above a star/fork control its button-group wrapper may sit.
const BUTTON_GROUP_WALK_DEPTH = 8;

// Narrow selector first: closestWithin returns the NEAREST match, so this prefers a farther
// div[role="group"] wrapper over a nearer bare .gl-button-group.
function resolveButtonGroup(el: HTMLElement): HTMLElement {
  return closestWithin(el, BUTTON_GROUP_SELECTOR, BUTTON_GROUP_WALK_DEPTH) ?? closestWithin(el, BUTTON_GROUP_CLASS_SELECTOR, BUTTON_GROUP_WALK_DEPTH) ?? el;
}

// GitLab and Facebook are the two sites whose key is NOT URL-derivable (see
// adapters/target-contract.ts and the `notUrlDerivable` list in
// __data__/target-vectors.json): the numeric project id is the stable identity,
// and it lives only in the page's DOM.
//
// The consequence to know before touching this: the id has TWO shapes. When the
// Project ID element has not rendered (a layout that omits it, a pre-hydration
// scan) the key falls back to the project PATH, so the same project can be
// counted under `12345` and under `owner/repo`. Renaming the project moves the
// path but not the numeric id, which is why the numeric one is preferred. Do
// not "simplify" this to one source - dropping the numeric id re-keys every
// existing GitLab reaction, and dropping the fallback leaves pages with no
// Project ID panel with no reaction button at all.
function extractProjectTarget(root: ParentNode): TargetRef | null {
  const projectRef = extractGitLabProjectRef(location.href);
  if (!projectRef) return null;
  const projectId = extractProjectId(root);
  return {
    site: "gitlab",
    targetId: projectId ?? projectRef.path,
    url: projectRef.url,
  };
}

function extractProjectId(root: ParentNode): string | null {
  for (const el of queryAll<HTMLElement>(root, PROJECT_ID_SELECTORS)) {
    const text = el.textContent ?? "";
    const match = text.match(/\bProject ID:\s*(\d+)\b/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

export function extractGitLabProjectRef(href: string): { path: string; url: string } | null {
  return parseSiteHref(href, "gitlab", (url) => {
    const path = projectPathFromPathname(url.pathname);
    if (!path) return null;
    return {
      path,
      url: `https://gitlab.com/${path}`,
    };
  });
}

function projectPathFromPathname(pathname: string): string | null {
  const segments = pathSegments(pathname);
  const dashIndex = segments.indexOf("-");
  const projectSegments = dashIndex >= 0 ? segments.slice(0, dashIndex) : segments;
  if (projectSegments.length < 2) return null;
  const first = projectSegments[0]?.toLowerCase();
  if (!first || RESERVED_PATHS.has(first)) return null;
  return projectSegments.join("/");
}

const RESERVED_PATHS = new Set(["-", "admin", "dashboard", "explore", "groups", "help", "oauth", "profile", "projects", "search", "users"]);

export default gitlabAdapter;
