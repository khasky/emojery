// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page-visibility (privacy) detection. A page is PRIVATE when its content is not viewable by an
// anonymous public visitor (a private repository / project / group / account); the extension
// must not show its reaction button there - a reaction can only be recorded for a publicly
// addressable target.
//
// Contract for every detector: return `true` ONLY on a positive, unambiguous private signal;
// `false` otherwise (fail-OPEN). A false NEGATIVE is safe - a visitor with no access is served
// a 404 with no Star control, so nothing mounts anyway. These detectors exist for the
// owner/collaborator who CAN see the private page in full (Star button present, lock badge
// shown) - there the button would otherwise mount. A false POSITIVE hides the button on a
// genuinely public page, so each signal below is specific and, where possible,
// locale-independent.
//
// Every detector takes its scan root explicitly (the adapter's `ScanContext` root) and touches
// no global, so a subtree scan is never answered from the whole document.
//
// The DOM half of each detector - which element carries the signal - is covered by the live e2e
// suites only: unit-testing it would mean constructing GitHub/GitLab repo-header markup, which
// the repo's unit-test rule forbids. The DECISION each one reads off that element takes a plain
// string, so it lives in its own function below and IS unit-tested (page-visibility.test.ts) -
// the same split as ui/mount-style.ts -> ui/mount-style-math.ts. Keep it when adding a detector:
// the live e2e fixtures are public repos and public projects, so a verdict that no public page
// can produce (GitLab `internal`) has no other way to be checked at all.

import { queryFirst } from "../shared/dom-query";

function metaContent(root: ParentNode, name: string): string | null {
  const el = root.querySelector(`meta[name="${name}"]`);
  return el?.getAttribute("content") ?? null;
}

// GitHub

// Repo-title containers that carry the visibility badge next to the repo name.
const GITHUB_REPO_HEADER_SELECTORS = ["#repository-container-header", "#repo-title-component"];

// Primary (variant B, embedded metadata): GitHub stamps the repo visibility into
// <head> as `<meta name="octolytics-dimension-repository_public" content="true|false">`,
// present on the owner's own view too and fully locale-independent.
// Fallback (variant A, DOM heuristics): the repo header shows a lock octicon and
// a "Private"/"Internal" badge next to the repo name (GitHub's UI is
// English-only, so the badge text is reliable; the octicon class regardless).
export function isPrivateGithubRepoPage(root: ParentNode): boolean {
  const fromMeta = githubPrivateFromMeta(metaContent(root, "octolytics-dimension-repository_public"));
  return fromMeta ?? githubHeaderShowsPrivate(root);
}

/** The meta tag's verdict, or `null` for "it did not say" - a missing tag, but also any
 *  content that is not exactly `true`/`false`, so a future GitHub value never reads as
 *  public by accident. `null` sends the caller to the DOM fallback. */
export function githubPrivateFromMeta(content: string | null): boolean | null {
  if (content === "false") return true;
  if (content === "true") return false;
  return null;
}

function githubHeaderShowsPrivate(root: ParentNode): boolean {
  const header = queryFirst<HTMLElement>(root, GITHUB_REPO_HEADER_SELECTORS);
  if (!header) return false;
  // A lock octicon in the repo-title bar is GitHub's private/internal marker.
  if (header.querySelector("svg.octicon-lock")) return true;
  for (const el of Array.from(header.querySelectorAll<HTMLElement>("span"))) {
    const text = (el.textContent ?? "").trim();
    if (text === "Private" || text === "Internal") return true;
  }
  return false;
}

// GitLab

// GitLab renders a single visibility icon in the project-name heading:
// `<button class="visibility-icon"><svg><use href="...#earth|#lock|#shield">`.
// The icon is an asset fragment id, not text, so it is locale-independent.
//   #earth  -> public      (anonymously viewable)
//   #lock   -> private     (members only)
//   #shield -> internal    (any signed-in user - NOT anonymously viewable)
const GITLAB_VISIBILITY_ICON_SELECTORS = [".visibility-icon use", 'h1[data-testid="project-name-content"] svg use'];

// Not exported: it only names the argument and return of the two functions below.
type GitlabVisibility = "earth" | "lock" | "shield";

export function isPrivateGitlabProjectPage(root: ParentNode): boolean {
  const use = queryFirst<SVGUseElement>(root, GITLAB_VISIBILITY_ICON_SELECTORS);
  if (!use) return false;
  return isPrivateGitlabVisibility(gitlabVisibilityFromIconHref(use.getAttribute("href") ?? use.getAttribute("xlink:href") ?? ""));
}

/** The visibility the icon's sprite reference names, or `null` for an href naming none -
 *  a sprite rename, or a `use` that points at something else entirely. */
export function gitlabVisibilityFromIconHref(href: string): GitlabVisibility | null {
  return (href.match(/#(earth|lock|shield)\b/)?.[1] as GitlabVisibility | undefined) ?? null;
}

/** `internal` (#shield) counts as private HERE: it is viewable by any signed-in user of the
 *  instance, which is not the anonymous public a reaction target has to be addressable to. */
export function isPrivateGitlabVisibility(visibility: GitlabVisibility | null): boolean {
  return visibility === "lock" || visibility === "shield";
}
