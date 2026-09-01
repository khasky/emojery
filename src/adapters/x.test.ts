// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { expectMatchesRegistryHosts } from "./test-fixtures";
import xAdapter, { extractXStatusRef } from "./x";

const HANDLE = "Pirat_Nation";
const STATUS_ID = "2058156237737295928";
const STATUS_URL = `https://x.com/${HANDLE}/status/${STATUS_ID}`;

describe("x adapter", () => {
  it("matches x.com hosts only", () => {
    expectMatchesRegistryHosts(xAdapter, "x");
    expect(xAdapter.matches("twitter.com")).toBe(false);
    expect(xAdapter.matches("mobile.x.com")).toBe(false);
  });

  it("extracts canonical status refs from status and analytics links", () => {
    expect(extractXStatusRef(`${STATUS_URL}/analytics`)).toEqual({
      handle: HANDLE,
      statusId: STATUS_ID,
      url: STATUS_URL,
    });
    expect(extractXStatusRef(`${STATUS_URL}/photo/1`)).toEqual({
      handle: HANDLE,
      statusId: STATUS_ID,
      url: STATUS_URL,
    });
    expect(extractXStatusRef("https://example.com/user/status/123")).toBeNull();
    expect(extractXStatusRef("https://x.com/home")).toBeNull();
  });
});
