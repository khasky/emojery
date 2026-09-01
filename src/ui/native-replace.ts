// SPDX-License-Identifier: GPL-3.0-or-later
//
// Hiding the native control the picker replaces, for the "Hide original
// buttons" setting.
import { elementsToArray, type PickerInsertionPoint } from "../shared/adapter";
import { HIDDEN_ATTR, HIDDEN_SELECTOR } from "../shared/dom";
import { queryAllDeep } from "../shared/dom-query";

// Hide the native control(s) the picker takes over. The `data-khasky-emojery-hidden`
// marker keeps re-scans resolving onto this collapsed slot instead of re-anchoring onto the
// next visible sibling (see visual-action-row.ts `isRenderableInPageLayout`). Call BEFORE
// inserting the picker so the row reflows once into its final shape instead of briefly
// showing the native control and the picker side by side. Idempotent per element.
export function hideNativeForReplace(point: PickerInsertionPoint): void {
  const targets = elementsToArray(point.replaceElement ?? point.nativeElement);
  for (const el of targets) {
    if (el.getAttribute(HIDDEN_ATTR) === "1") continue;
    el.setAttribute(HIDDEN_ATTR, "1");
    el.style.setProperty("display", "none", "important");
  }
}

// Undo every hide when the extension is turned off (see mount.ts `unmountAll`). Scans the
// live DOM rather than a registry - the hidden control is a page element, not one we own.
// The scan must pierce open shadow roots: Reddit's vote block lives inside shreddit-post's
// shadow DOM, where a plain querySelectorAll never finds the hidden marker - toggling
// "Hide original buttons" off left every already-hidden vote control hidden for good.
export function restoreHiddenNatives(): void {
  for (const el of queryAllDeep<HTMLElement>(document, [HIDDEN_SELECTOR])) {
    el.style.removeProperty("display");
    el.removeAttribute(HIDDEN_ATTR);
  }
}
