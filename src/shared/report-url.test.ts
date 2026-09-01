// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { reportPageUrl } from "./report-url";

describe("reportPageUrl", () => {
  it("keeps the YouTube video id but drops playlist/session params", () => {
    const u = new URL("https://www.youtube.com/watch?v=8Yedo-lK3t0&list=TLPQMDUwNzIwMjY&index=3");
    expect(reportPageUrl(u, "youtube")).toBe("https://www.youtube.com/watch?v=8Yedo-lK3t0");
  });

  it("keeps Facebook photo identity params only", () => {
    const u = new URL("https://www.facebook.com/photo/?fbid=123456&set=a.789&__cft__[0]=trackingtoken&__tn__=%2CO");
    expect(reportPageUrl(u, "facebook")).toBe("https://www.facebook.com/photo/?fbid=123456&set=a.789");
  });

  it("strips the whole query on path-identified sites", () => {
    const u = new URL("https://github.com/torvalds/linux?tab=readme-ov-file#readme");
    expect(reportPageUrl(u, "github")).toBe("https://github.com/torvalds/linux");
  });

  it("leaves a bare URL untouched", () => {
    const u = new URL("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(reportPageUrl(u, "youtube")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
});
