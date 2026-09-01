// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import amazonAdapter, { asinFromPathname } from "./amazon";
import { expectMatchesRegistryHosts } from "./test-fixtures";

describe("amazon adapter", () => {
  it("matches every supported amazon TLD", () => {
    expectMatchesRegistryHosts(amazonAdapter, "amazon");
    // Regional catch-all (hostRegex) - not in the explicit `hosts` list.
    expect(amazonAdapter.matches("www.amazon.nl")).toBe(true);
    expect(amazonAdapter.matches("github.com")).toBe(false);
  });
});

describe("asinFromPathname", () => {
  it("extracts the ASIN from every product-path shape", () => {
    expect(asinFromPathname("/dp/B01LYNW421")).toBe("B01LYNW421");
    expect(asinFromPathname("/gp/product/B01LYNW421")).toBe("B01LYNW421");
    expect(asinFromPathname("/Some-Title/dp/B01LYNW421/ref=sr_1_1")).toBe("B01LYNW421");
    expect(asinFromPathname("/-/en/dp/B01LYNW421")).toBe("B01LYNW421");
  });

  it("accepts lowercase and uppercases the result", () => {
    expect(asinFromPathname("/dp/b01lynw421")).toBe("B01LYNW421");
  });

  it("returns null for non-product paths and wrong-length ids", () => {
    expect(asinFromPathname("/")).toBeNull();
    expect(asinFromPathname("/gp/help/customer/display.html")).toBeNull();
    expect(asinFromPathname("/dp/B01LYNW42")).toBeNull(); // 9 chars
  });
});
