// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryAll, queryFirst } from "../shared/dom-query";
import { type Binding, defineSiteAdapter } from "./framework";
import { isPrivateGithubRepoPage } from "./page-visibility";
import { findFirstAnchor } from "./placement";
import { firstAncestor, matchesAny } from "./runtime";
import { parseSiteHref, pathSegments, urlTargetResolver } from "./url-target";

// GitHub iterates its repo header markup frequently - order selectors from
// most-specific to most-permissive; the first hit wins. The 2025 Primer-React
// header dropped `#repo-stars-counter-star`, `ReactStarringButton` and the
// `/star` `/unstar` forms, so the first four match older layouts only; today's
// header matches on the aria-label pair (`Star torvalds/linux` / `Unstar ...`),
// which is also the most stable across redesigns and both auth states.
const STAR_SELECTORS = ["#repo-stars-counter-star", 'div[data-component="ReactStarringButton"]', 'form[action$="/star"]', 'form[action$="/unstar"]', 'button[aria-label^="Star "][aria-label*="/"]', 'button[aria-label^="Unstar "][aria-label*="/"]', 'button[data-testid$="star-button"]', 'button[data-ga-click*="star" i]'];

// Preferred search scope (avoids false positives elsewhere on the page). Current
// Primer layout tags the action row `data-testid="repo-header-actions"`; older
// layouts used the rest. If none match, fall back to a document-wide scan.
const REPO_HEADER_SELECTORS = ['ul[data-testid="repo-header-actions"]', "#repository-container-header", "#repository-details-container", "ul.pagehead-actions", '[data-testid="repos-header-action-bar"]', '[data-target="repository-actions.list"]', "header.AppHeader, header.gh-header"];

// The repo-action row is a `<ul>` of `<li>` items (Watch / Fork / Star). Mount
// the picker as a fresh sibling `<li>` so it rides the row's own flex-wrap
// spacing instead of landing inside the Star button's wrapper (where it wraps
// onto a second line).
const ACTION_LIST_SELECTORS = ['ul[data-testid="repo-header-actions"]', "ul.pagehead-actions"];
const ACTION_LIST_WRAPPER = { tagName: "li" };

// GitHub hides the repo-action `<ul>` on a narrow viewport, taking the primary
// placement with it; these resolve the always-visible repo-name link as the
// fallback anchor (the `strong[itemprop='name']` breadcrumb is the legacy shape).
// Each selector's matches are filtered to a RENDERED one (`offsetParent`) before
// falling through to the next: `#code-view-repo-link` stays in the DOM but
// `hidden` on a narrow viewport, and a hidden match would win by priority and
// mount on an anchor that never becomes visible, stalling mount.ts's
// IntersectionObserver forever.
const NARROW_HEADER_ANCHOR_SELECTORS = ["#code-view-repo-link", "a[data-testid='repo-name-link']", "#repository-container-header strong[itemprop='name']", "#repository-container-header #repo-title-component"];
const NARROW_HEADER_ANCHOR_CANDIDATES = NARROW_HEADER_ANCHOR_SELECTORS.map((selector) => ({
  selectors: [selector],
  accept: (el: HTMLElement) => (el.offsetParent !== null ? el : null),
}));

// Pressed-state read for auto-press: on the 2025 Primer-React header the
// aria-label is the ONLY thing that flips (`Star owner/repo` <-> `Unstar ...`) -
// no `aria-pressed`, no `/star` form, and `data-testid` stays `star-button` in
// BOTH states, so readPressed's generic signals cannot answer. Any other shape
// reads UNKNOWN (null) - see the likePressed contract in shared/adapter.ts.
export function githubStarLabelPressed(label: string): boolean | null {
  if (/^unstar\s/i.test(label)) return true;
  if (/^star\s/i.test(label)) return false;
  return null;
}

function githubStarPressed(btn: HTMLElement): boolean | null {
  return githubStarLabelPressed(btn.getAttribute("aria-label")?.trim() ?? "");
}

export function githubTargetFromRef(ref: { owner: string; repo: string }): TargetRef {
  return {
    site: "github",
    targetId: `${ref.owner}/${ref.repo}`,
    url: `https://github.com/${ref.owner}/${ref.repo}`,
  };
}

// The repo target is URL-derived (owner/repo from the page URL), independent of the candidate -
// the location-only shape `urlTargetResolver` was built for.
const resolveRepoTarget = urlTargetResolver({
  parse: repoRefFromHref,
  toTarget: githubTargetFromRef,
});

const githubAdapter = defineSiteAdapter({
  site: "github",
  // Never react on a private repo, even when the owner/collaborator can see it
  // in full (visibility meta = `false`, or a lock/"Private" badge in the header).
  isPrivatePage: ({ root }) => isPrivateGithubRepoPage(root),
  findCandidates: ({ root }) => {
    const starAnchor = findStarAnchor(root);
    return starAnchor ? [starAnchor] : [];
  },
  resolveTarget: resolveRepoTarget,
  resolveBinding: (starAnchor, { root }) => {
    const configuredAnchor = findActionListItem(starAnchor);
    const anchor = configuredAnchor ?? starAnchor;
    const usesActionListItem = isActionListItem(anchor);
    const replaceElement = usesActionListItem ? anchor : null;
    // For "Hide original buttons": when the anchor is a row `<li>`, hide the whole Star
    // `<li>` so authenticated split-button dropdowns disappear with the main
    // Star button. In other layouts, hide the actual Star control.
    const counter = queryFirst<HTMLElement>(root, ["#repo-stars-counter-star"]);
    // row <li> -> counter's control -> the star control -> a control inside it
    const nativeElement = replaceElement ?? counter?.closest<HTMLElement>("a, button") ?? starAnchor.closest<HTMLElement>("a, button") ?? starAnchor.querySelector<HTMLElement>("a, button");
    const binding: Binding = {
      anchor,
      position: "after",
      ...(usesActionListItem ? { wrapper: ACTION_LIST_WRAPPER } : {}),
    };
    if (nativeElement) binding.nativeElement = nativeElement;
    if (replaceElement) binding.replaceElement = replaceElement;
    // Auto-press needs the real Star <button> (submits the star form). Signed
    // out the control is an <a> to /login - pressing that would navigate, so
    // only a BUTTON qualifies.
    const starButton = counter?.closest<HTMLElement>("button") ?? starAnchor.closest<HTMLElement>("button") ?? starAnchor.querySelector<HTMLElement>("button");
    if (starButton) binding.nativeVote = { like: starButton, likePressed: () => githubStarPressed(starButton) };
    // When the header action bar collapses at narrow widths, mount beside the
    // repo name in the always-visible header instead of inside the hidden bar.
    // mount.ts uses this only while the primary anchor is not rendered.
    const fallbackAnchor = findFirstAnchor(root, NARROW_HEADER_ANCHOR_CANDIDATES);
    if (fallbackAnchor && fallbackAnchor !== anchor) {
      binding.fallback = { anchor: fallbackAnchor, position: "after" };
    }
    return binding;
  },
  // GitHub uses Turbo for in-page nav since 2023; both events fire. `resize` is
  // the MutationObserver's blind spot: a pure CSS breakpoint flipping the action
  // bar's `display` mutates no DOM node, so without it the placement's narrow-width
  // `fallback` (see PickerInsertionPoint.fallback) goes stale. The scan is
  // debounced and idempotent, so re-running it on resize is cheap.
  observer: {
    debounceMs: 200,
    navKey: "pathname",
    triggerEvents: ["turbo:render", "turbo:load", "resize"],
  },
});

// Prefer a repo-header container so a star-like control elsewhere on the page can't win; falls
// back to a document-wide scan.
function findStarAnchor(root: ParentNode): HTMLElement | null {
  const search = (scope: ParentNode): HTMLElement | null => findFirstAnchor(scope, [{ selectors: STAR_SELECTORS, accept: resolveStarAnchor }]);
  for (const container of queryAll<HTMLElement>(root, REPO_HEADER_SELECTORS)) {
    const hit = search(container);
    if (hit) return hit;
  }
  return search(root);
}

// Resolve the picker anchor for an inner star element (counter span, button, form).
// Order: split-button group with a dropdown -> the interactive <a>/<button> (unauthed
// Star is an <a href="/signin?..."> wrapping the counter span - returning the span would
// drop the picker INSIDE the link) -> <form> -> group -> <li> -> the element itself.
function resolveStarAnchor(el: HTMLElement): HTMLElement {
  const group = el.closest<HTMLElement>('.BtnGroup, div[data-component="ReactStarringButton"]');
  if (group && hasStarDropdown(group)) return group;
  const ctrl = el.closest<HTMLElement>("a, button");
  if (ctrl) return ctrl;
  // Loose form match: the unauthed action URL (`/signin?return_to=...`) doesn't
  // share the `/star`/`/unstar` suffix. The counter span lives only in
  // star-related contexts, so the closest form is the Star form.
  const form = el.closest<HTMLElement>("form");
  if (form) return form;
  if (group) return group;
  const li = el.closest<HTMLElement>("li");
  if (li) return li;
  return el;
}

function findActionListItem(el: HTMLElement): HTMLElement | null {
  return findListItemWithin(el, ACTION_LIST_SELECTORS, 10);
}

function isActionListItem(el: HTMLElement): boolean {
  return el.tagName === "LI" && isListItemWithin(el, ACTION_LIST_SELECTORS);
}

// GitHub-local (the repo-action row is a <ul> of <li>).
export function findListItemWithin(el: HTMLElement, withinSelectors: readonly string[], maxDepth: number): HTMLElement | null {
  return firstAncestor(el, maxDepth, (node) => node.tagName === "LI" && isListItemWithin(node, withinSelectors));
}

// GitHub-local (the repo-action row is a <ul> of <li>).
export function isListItemWithin(el: HTMLElement, withinSelectors: readonly string[]): boolean {
  const parent = el.parentElement;
  if (!parent) return false;
  return matchesAny(parent, withinSelectors);
}

function hasStarDropdown(group: HTMLElement): boolean {
  return !!group.querySelector('user-list-menu, select-panel, details, button[aria-haspopup="dialog"], button[aria-haspopup="menu"]');
}

// Pure: derives the owner/repo from a pathname, rejecting site-level reserved routes.
export function repoRefFromPathname(pathname: string): { owner: string; repo: string } | null {
  // A repo root is exactly two path segments (`/owner/repo`); deeper paths
  // (tree/blob/issues/...) are not the repo home.
  const segments = pathSegments(pathname);
  if (segments.length !== 2) return null;
  const [owner, repo] = segments;
  // Case-folded for the gate only: GitHub routes owners case-insensitively, so
  // /Settings/profile is the settings page. The ref keeps the URL's own casing -
  // it is half of the target key the backend sees.
  if (!owner || !repo || RESERVED_PATHS.has(owner.toLowerCase())) return null;
  return { owner, repo };
}

// Parse an href to its owner/repo ref. Gated to github.com so a stray
// cross-origin link can't be read as the repo target (the adapter only runs on
// github.com, so in practice this is always the page URL). Exported for
// `target-contract.ts`, which derives from a bare URL and needs that host gate.
export function repoRefFromHref(href: string): { owner: string; repo: string } | null {
  return parseSiteHref(href, "github", (url) => repoRefFromPathname(url.pathname));
}

const RESERVED_PATHS = new Set(["settings", "notifications", "marketplace", "explore", "topics", "trending", "collections", "events", "sponsors", "pulls", "issues", "codespaces", "new", "login", "logout", "signup", "search", "orgs", "organizations", "features", "pricing", "about", "contact", "site"]);

export default githubAdapter;
