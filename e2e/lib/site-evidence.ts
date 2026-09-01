// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shapes the live-site suites pass around: the scenario under test and the
// evidence one page probe collects about it. Kept apart from the probes
// themselves so both the collectors (lib/page-settle.ts) and the interaction
// helpers (lib/picker-probes.ts) can depend on them without a cycle.
import { SITE_LABELS } from "../../src/shared/sites";
import type { SiteId, SiteScenarioSpec } from "../supported-sites";

// A registry scenario with its URL resolved from the environment.
export type SupportedSiteScenario = SiteScenarioSpec & { url: string };

// The scroll pass used for a scenario that declares no `scrollSteps` of its own.
// One definition: the evidence wait, the trigger wait, the mounted-key wait and
// the disabled-site wait all scroll the same page, and a per-caller copy is a
// silent drift.
export const DEFAULT_SCROLL_STEPS = [0, 450, 900, 1350];
export interface PickedReaction {
  reaction: string;
  targetKey: string;
}

export interface MountEvidence {
  url: string;
  title: string;
  bodyTextSample: string;
  hostCount: number;
  visibleHostCount: number;
  hiddenNativeCount: number;
  matchingHostCount: number;
  visibleMatchingHostCount: number;
  anchorKeys: string[];
  matchingAnchorKeys: string[];
  hostSamples: Array<{
    mountKey: string | null;
    text: string;
    visible: boolean;
    rect: Rect;
    display: string;
    visibility: string;
    opacity: string;
    offset: { width: number; height: number };
    zeroAncestor: string | null;
    root: string;
  }>;
  hiddenNativeSamples: Array<{
    tag: string;
    text: string;
    rect: Rect;
    display: string;
    visibility: string;
  }>;
  nativeCount: number;
  visibleNativeCount: number;
  containerCount: number;
  placementOk: boolean;
  placementReason: string;
  closestNativeDistance: number | null;
  missingRequiredHostAncestors: string[];
  // Visual-correctness signals beyond proximity (a host can be "near" a native
  // action yet still be wrong): a target key on more than one connected anchor
  // (duplicate/stolen-host), a host sitting on top of a native control/label
  // rather than beside it (the Facebook photo overlap class), a host clipped by
  // an overflow ancestor, a matching host trapped inside a hidden ancestor, and
  // a stray visible tooltip (Facebook date-hover artifact). The default-unauth
  // loop hard-asserts only the duplicate-key signal and surfaces the rest in
  // evidence for debugging.
  duplicateMatchingKeys: string[];
  maxHostNativeOverlapRatio: number;
  clippedMatchingCount: number;
  matchingInsideHiddenAncestorCount: number;
  roleTooltipVisibleCount: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  top: number;
  right: number;
  bottom: number;
  left: number;
}

// The registry's own label, not a copy: this value is matched against the popup's
// rendered accessible name ("Show the picker on <label>", lib/popup-probes.ts), and
// the popup renders it from SITE_LABELS. A local table would let a renamed brand
// surface as "checkbox not found" instead of as drift.
export function siteLabel(site: SiteId): string {
  return SITE_LABELS[site];
}
