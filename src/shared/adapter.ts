// SPDX-License-Identifier: GPL-3.0-or-later

import type { SupportedSite } from "./sites";

export type { SupportedSite };

export interface TargetRef {
  site: SupportedSite;
  targetId: string;
  url: string;
}

/**
 * Native controls that the "Auto-press native buttons" setting may press for
 * this point. Semantic, unlike `nativeElement` (which is "what to hide"): `like` /
 * `dislike` are the actual clickable controls. Adapters fill what the site
 * has; an absent field means the site offers no such action here.
 */
export interface NativeVoteActions {
  like?: HTMLElement;
  dislike?: HTMLElement;
  /**
   * Site-specific pressed-state read for `like` where no generic signal
   * (aria-pressed / data-testid / form action) exists - an adapter supplies it
   * wherever the pressed state is only readable from a site-specific label or
   * icon. `null` = unknown; the trigger engine then refuses to press rather
   * than risk toggling a manual like off.
   */
  likePressed?: () => boolean | null;
  /**
   * Facebook's hover flyout with the 7 reactions; `trigger` is the Like
   * button that opens it. `findMenu` locates the OPENED flyout's reaction
   * buttons in flyout-position order (the locale-proof handle) - adapter-owned
   * so the site-specific dialog heuristics stay out of shared bundles.
   */
  reactionMenu?: {
    trigger: HTMLElement;
    kind: "facebook";
    findMenu: () => HTMLElement[] | null;
  };
}

export interface PickerInsertionPoint {
  anchor: HTMLElement;
  position: "before" | "after" | "append";
  target: TargetRef;
  nativeVote?: NativeVoteActions;
  /**
   * Native control(s) (Star button, Like button, ...) the picker conceptually
   * replaces; with the `replaceNative` setting on, mount.ts hides them.
   */
  nativeElement?: HTMLElement | HTMLElement[];
  /**
   * Element(s) to hide when `replaceNative` is enabled. Defaults to
   * `nativeElement`; override when the visual slot that must disappear is
   * larger than the control used for measurement/typography.
   */
  replaceElement?: HTMLElement | HTMLElement[];
  /**
   * Optional page-native wrapper created around the picker host, for layouts
   * that expect direct children of a specific tag (GitHub's
   * `ul.pagehead-actions > li`) or a sibling's layout role (X's grow columns,
   * via `style`).
   */
  wrapper?: {
    tagName: string;
    className?: string;
    style?: string;
  };
  /**
   * Mount now instead of deferring to the viewport IntersectionObserver. Set
   * for SINGLE-post pages (a Facebook permalink / photo / reel viewer) where a
   * long post pushes the action row below the fold and the lazy mount reads as
   * "no reaction button". Leave unset on feeds, where lazy is the right default.
   */
  mountImmediately?: boolean;
  /**
   * Trigger form. Omitted (or "row") renders the default horizontal form; an
   * adapter binding a vertical icon rail (FB/IG reel viewers, YouTube Shorts)
   * opts in with "icon-column" for the round rail-matching form. Deliberately
   * explicit, no auto-detection: ordinary pages stack wide links vertically
   * too, so only an opt-in keeps every non-rail placement horizontal (see
   * mount-style.ts readActionLayout).
   */
  triggerLayout?: "row" | "icon-column";
  /**
   * Alternate placement used only while the primary `anchor` is not rendered
   * (`display:none` / zero size - e.g. a responsive header hiding its action
   * bar below a width breakpoint). mount.ts picks primary vs. fallback by the
   * primary anchor's rendered visibility and re-evaluates on a debounced
   * viewport resize (a `"resize"` entry in the adapter's observer
   * `triggerEvents`). Leave unset when the anchor is always rendered.
   */
  fallback?: Pick<PickerInsertionPoint, "anchor" | "position" | "wrapper" | "triggerLayout">;
}

/** Normalize the `nativeElement` / `replaceElement` union above to a list. */
export function elementsToArray(elements: HTMLElement | HTMLElement[] | undefined): HTMLElement[] {
  if (!elements) return [];
  return Array.isArray(elements) ? elements : [elements];
}

export interface SiteAdapter {
  readonly site: SupportedSite;

  matches(host: string): boolean;

  scan(root: ParentNode): PickerInsertionPoint[];

  observe(onUpdate: (points: PickerInsertionPoint[]) => void): () => void;
}
