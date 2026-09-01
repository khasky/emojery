// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { PickerInsertionPoint } from "../shared/adapter";
import { hideNativeForReplace, restoreHiddenNatives } from "./native-replace";

function pointWith(native: HTMLElement): PickerInsertionPoint {
  return {
    target: { site: "reddit", targetId: "t3_x", url: "https://www.reddit.com/r/x/comments/x/" },
    anchor: document.createElement("div"),
    position: "after",
    nativeElement: native,
  };
}

describe("hideNativeForReplace / restoreHiddenNatives", () => {
  it("hides and restores a light-DOM control", () => {
    const native = document.createElement("div");
    document.body.appendChild(native);

    hideNativeForReplace(pointWith(native));
    expect(native.style.display).toBe("none");
    expect(native.dataset.khaskyEmojeryHidden).toBe("1");

    restoreHiddenNatives();
    expect(native.style.display).toBe("");
    expect(native.dataset.khaskyEmojeryHidden).toBeUndefined();
    native.remove();
  });

  it("restores a control hidden inside an open shadow root", () => {
    const outer = document.createElement("div");
    document.body.appendChild(outer);
    const shadow = outer.attachShadow({ mode: "open" });
    const inner = document.createElement("div");
    const nested = inner.attachShadow({ mode: "open" });
    const native = document.createElement("div");
    nested.appendChild(native);
    shadow.appendChild(inner);

    hideNativeForReplace(pointWith(native));
    expect(native.style.display).toBe("none");

    restoreHiddenNatives();
    expect(native.style.display).toBe("");
    expect(native.dataset.khaskyEmojeryHidden).toBeUndefined();
    outer.remove();
  });
});
