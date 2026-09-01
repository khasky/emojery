// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { PickerInsertionPoint } from "../shared/adapter";
import { compactCountText, compactNativeCounts, compactQuotedLabelText, restoreCompactedCounts } from "./native-compact";

describe("compactCountText", () => {
  it("compacts grouped integers with any locale separator", () => {
    expect(compactCountText("327 555")).toBe("327K");
    expect(compactCountText("327,555")).toBe("327K");
    expect(compactCountText("327.555")).toBe("327K");
    expect(compactCountText("327'555")).toBe("327K");
    expect(compactCountText("327 555")).toBe("327K");
    expect(compactCountText("327 555")).toBe("327K");
    expect(compactCountText("11 900 000")).toBe("11.9M");
    expect(compactCountText("112 900 000")).toBe("112M");
  });

  it("keeps one truncated decimal below 100K / 100M", () => {
    expect(compactCountText("12 345")).toBe("12.3K");
    expect(compactCountText("2 490")).toBe("2.4K");
    expect(compactCountText("1 234 567")).toBe("1.2M");
    expect(compactCountText("12 000")).toBe("12K");
  });

  // A billion-scale counter used to render as "2000M": the grouped-integer path stopped at
  // M while the Cyrillic path already latinized "млрд" to "B".
  it("reaches the B tier the Cyrillic path already produced", () => {
    expect(compactCountText("2 000 000 000")).toBe("2B");
    expect(compactCountText("1 234 000 000")).toBe("1.2B");
    expect(compactCountText("112 000 000 000")).toBe("112B");
    expect(compactCountText("999 999 999")).toBe("999M");
  });

  it("compacts plain digit runs too", () => {
    expect(compactCountText("1000")).toBe("1K");
    expect(compactCountText("327555")).toBe("327K");
  });

  it("returns null below 1000 or when the text is no counter", () => {
    expect(compactCountText("999")).toBeNull();
    expect(compactCountText("12.3K")).toBeNull();
    expect(compactCountText("1 234 likes")).toBeNull();
    expect(compactCountText("12:34")).toBeNull();
    expect(compactCountText("")).toBeNull();
  });

  it("latinizes Cyrillic-compacted counters (X in RU/UA)", () => {
    expect(compactCountText("5 тис.")).toBe("5K");
    expect(compactCountText("5 тыс.")).toBe("5K");
    expect(compactCountText("682,1 тис.")).toBe("682.1K");
    expect(compactCountText("12.5 тыс")).toBe("12.5K");
    expect(compactCountText("1,2 млн")).toBe("1.2M");
    expect(compactCountText("2 млрд")).toBe("2B");
  });

  it("leaves non-counter Cyrillic text alone", () => {
    expect(compactCountText("тис.")).toBeNull();
    expect(compactCountText("5 тисяч людей")).toBeNull();
    expect(compactCountText("приблизно 5 тис.")).toBeNull();
  });
});

describe("compactQuotedLabelText", () => {
  it("extracts the quoted short name from a verbose like label", () => {
    expect(compactQuotedLabelText('Поставить "Нравится"')).toBe("Нравится");
    expect(compactQuotedLabelText("Поставить «Нравится»")).toBe("Нравится");
    expect(compactQuotedLabelText("Setze „Gefällt mir“")).toBe("Gefällt mir");
  });

  it("returns null for labels without a trailing quoted phrase", () => {
    expect(compactQuotedLabelText("Like")).toBeNull();
    expect(compactQuotedLabelText("Нравится")).toBeNull();
    expect(compactQuotedLabelText('Сказал "привет" всем')).toBeNull();
    expect(compactQuotedLabelText("327 555")).toBeNull();
    expect(compactQuotedLabelText("")).toBeNull();
  });
});

describe("compactNativeCounts / restoreCompactedCounts", () => {
  function pointWith(native: HTMLElement): PickerInsertionPoint {
    return {
      target: { site: "instagram", targetId: "x", url: "https://www.instagram.com/p/x/" },
      anchor: document.createElement("div"),
      position: "after",
      nativeElement: native,
    };
  }

  it("rewrites only single-text-node counter leaves and restores them", () => {
    const native = document.createElement("div");
    const count = document.createElement("span");
    count.textContent = "327 555";
    const label = document.createElement("span");
    label.textContent = "likes and 3 comments";
    native.append(count, label);
    document.body.appendChild(native);

    compactNativeCounts(pointWith(native));
    expect(count.textContent).toBe("327K");
    expect(label.textContent).toBe("likes and 3 comments");

    compactNativeCounts(pointWith(native));
    expect(count.textContent).toBe("327K");

    restoreCompactedCounts();
    expect(count.textContent).toBe("327 555");
    expect(count.hasAttribute("data-khasky-emojery-count")).toBe(false);
    native.remove();
  });

  it("restores a counter compacted inside an open shadow root", () => {
    const outer = document.createElement("div");
    document.body.appendChild(outer);
    const shadow = outer.attachShadow({ mode: "open" });
    const native = document.createElement("div");
    const count = document.createElement("span");
    count.textContent = "327 555";
    native.appendChild(count);
    shadow.appendChild(native);

    compactNativeCounts(pointWith(native));
    expect(count.textContent).toBe("327K");

    restoreCompactedCounts();
    expect(count.textContent).toBe("327 555");
    expect(count.hasAttribute("data-khasky-emojery-count")).toBe(false);
    outer.remove();
  });
});
