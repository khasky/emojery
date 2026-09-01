// SPDX-License-Identifier: GPL-3.0-or-later
//
// Placement toolkit: reusable anchor/slot resolution strategies that are not
// strictly visual geometry (that lives in visual-action-row.ts). A strategy
// earns its place here on a second consumer or a shared invariant worth
// pinning; a single-caller DOM walk stays next to its caller in that adapter.
// `slotAction` is counted with `findSiblingAction`, not against the rule: it
// builds that function's arguments and has no meaning apart from it.
import { queryAll, queryFirst } from "../shared/dom-query";
import { directChildSlot } from "./runtime";

// A prioritized anchor candidate for `findFirstAnchor`: the selectors that find
// it, and how to validate/transform a match into the final anchor (e.g. resolve a
// star control to its split-button group, or accept a container only when it
// holds a usable control). `accept` returning null rejects that match and the
// search moves on.
interface AnchorCandidate {
  selectors: readonly string[];
  accept?: (match: HTMLElement) => HTMLElement | null;
}

// First anchor produced by walking `candidates` in priority order: for each, the
// first selector match whose `accept` (default identity) yields a non-null
// element. The "single page-level anchor from a prioritized fallback chain"
// shape the static-anchor sites (one target per page) share.
export function findFirstAnchor(root: ParentNode, candidates: readonly AnchorCandidate[]): HTMLElement | null {
  for (const candidate of candidates) {
    for (const match of queryAll<HTMLElement>(root, candidate.selectors)) {
      const resolved = candidate.accept ? candidate.accept(match) : match;
      if (resolved) return resolved;
    }
  }
  return null;
}

// A candidate sibling action: the selectors that find it and how to turn a
// match into the anchor (e.g. its slot wrapper, or its button group).
interface SiblingAction {
  selectors: readonly string[];
  resolve: (match: HTMLElement) => HTMLElement | null;
}

// First sibling action found inside `scope`, in priority order, resolved to
// its anchor. Used to mount relative to a neighbouring native action
// (X's View/Bookmark, GitLab's More/Fork).
export function findSiblingAction(scope: HTMLElement, actions: readonly SiblingAction[]): HTMLElement | null {
  for (const action of actions) {
    const match = queryFirst<HTMLElement>(scope, action.selectors);
    if (!match) continue;
    const resolved = action.resolve(match);
    if (resolved) return resolved;
  }
  return null;
}

export function slotAction(row: HTMLElement, selectors: readonly string[]): SiblingAction {
  return {
    selectors,
    resolve: (match) => directChildSlot(match, row) ?? match,
  };
}
