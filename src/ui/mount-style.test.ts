// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { PickerInsertionPoint, TargetRef } from "../shared/adapter";
import { GLYPH_H_VAR, ICON_SIZE_VAR, LAYOUT_ATTR, PAGE_FONT_VAR, ROW_H_VAR, SITE_PAD_X_VAR, SITE_RADIUS_VAR } from "../shared/dom";
import { hostShapeSignature, readActionLayout } from "./mount-style";

const TARGET: TargetRef = {
  site: "youtube",
  targetId: "v",
  url: "https://www.youtube.com/watch?v=v",
};

// A single <button> returned as an insertion point anchored on it. No geometry:
// the assertions below resolve before readActionLayout reads any box.
function iconButton(): PickerInsertionPoint {
  const button = document.createElement("button");
  document.body.append(button);
  return { anchor: button, position: "after", target: TARGET, nativeElement: button };
}

describe("readActionLayout - icon-column is an explicit adapter opt-in", () => {
  it("keeps the row form unless the adapter opts in", () => {
    // No auto-detection: whatever the surrounding controls look like, only the
    // adapter's `triggerLayout` flips the trigger round. Without it the layout
    // is decided before any geometry is read, so no fixture can change this.
    expect(readActionLayout(iconButton()).iconColumn).toBe(false);
  });

  it("treats an explicit 'row' hint like the default", () => {
    const point = iconButton();
    point.triggerLayout = "row";
    expect(readActionLayout(point).iconColumn).toBe(false);
  });
});

// mount-reblend.ts stops its post-mount re-blend schedule once two passes in a row leave this
// signature unchanged, so anything reapplyHostShape stamps but the signature omits can be
// applied ONCE and then frozen by an early stop - a trigger that never picks up the radius
// its row hydrated a beat later. Each mutation below must therefore move the signature.
describe("hostShapeSignature covers every property the re-blend stamps", () => {
  const MUTATIONS: Array<[string, (host: HTMLElement) => void]> = [
    ["font family", (h) => h.style.setProperty("font-family", "Inter")],
    ["page font size", (h) => h.style.setProperty(PAGE_FONT_VAR, "15px")],
    ["site radius", (h) => h.style.setProperty(SITE_RADIUS_VAR, "18px")],
    ["site padding", (h) => h.style.setProperty(SITE_PAD_X_VAR, "12px")],
    ["row height", (h) => h.style.setProperty(ROW_H_VAR, "32px")],
    ["glyph height", (h) => h.style.setProperty(GLYPH_H_VAR, "22px")],
    ["icon size", (h) => h.style.setProperty(ICON_SIZE_VAR, "48px")],
    ["icon-column layout", (h) => h.setAttribute(LAYOUT_ATTR, "icon-column")],
    ["left margin", (h) => h.style.setProperty("margin-left", "6px")],
    ["right margin", (h) => h.style.setProperty("margin-right", "6px")],
    ["top margin", (h) => h.style.setProperty("margin-top", "6px")],
    ["bottom margin", (h) => h.style.setProperty("margin-bottom", "6px")],
  ];

  it.each(MUTATIONS)("changes when the %s changes", (_label, mutate) => {
    const host = document.createElement("span");
    const before = hostShapeSignature(host);
    mutate(host);
    expect(hostShapeSignature(host)).not.toBe(before);
  });

  it("is stable while nothing is restamped", () => {
    const host = document.createElement("span");
    host.style.setProperty(ROW_H_VAR, "32px");
    expect(hostShapeSignature(host)).toBe(hostShapeSignature(host));
  });
});
