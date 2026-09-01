// SPDX-License-Identifier: GPL-3.0-or-later
//
// The durable half of the trigger's blending: session cache seeding, the
// never-downgrade roundness gate, and the remembered per-site glyph height -
// the module state every mount-style read leans on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome } from "../test/fixtures";
import { glyphPxOrRemembered, preferRememberedRadius, preloadSiteStyle, rememberedSiteStyle, rememberSiteStyle, resetSiteStyleMemoryForTests, type SiteButtonStyle } from "./mount-style-memory";

// Hand-computed 24h TTL (not imported from the module, so a TTL regression
// fails here instead of co-mutating the expectation).
const TTL_MS = 24 * 60 * 60 * 1000;
const FROZEN_NOW = Date.UTC(2026, 0, 1);

let store: Record<string, unknown>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  store = installFakeChrome({ local: {} }).local;
  resetSiteStyleMemoryForTests();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// Wait out the fire-and-forget storage write (`void storageLocalSet(...)`).
async function flushWrites(): Promise<void> {
  await vi.waitFor(() => expect(Object.keys(store).length).toBeGreaterThan(0));
}

describe("preloadSiteStyle", () => {
  it("seeds the session cache from a stored style one tick inside the TTL", async () => {
    store["site_style_v1:youtube"] = { style: { borderRadius: "18px", backgroundColor: "red" }, at: FROZEN_NOW - TTL_MS + 1 };
    await preloadSiteStyle("youtube");
    expect(rememberedSiteStyle()).toEqual({ borderRadius: "18px", backgroundColor: "red" });
  });

  it("ignores a stored style one tick past the TTL", async () => {
    store["site_style_v1:youtube"] = { style: { borderRadius: "18px" }, at: FROZEN_NOW - TTL_MS - 1 };
    await preloadSiteStyle("youtube");
    expect(rememberedSiteStyle()).toBeNull();
  });

  it("drops the legacy %-radius and per-row padding from an older store", async () => {
    store["site_style_v1:youtube"] = { style: { borderRadius: "50%", paddingInline: "12px", color: "white" }, at: FROZEN_NOW };
    await preloadSiteStyle("youtube");
    expect(rememberedSiteStyle()).toEqual({ color: "white" });
  });

  it("seeds the remembered glyph from a stored value inside the TTL, not past it", async () => {
    store["site_glyph_v1:youtube"] = { px: 22, at: FROZEN_NOW - TTL_MS + 1 };
    await preloadSiteStyle("youtube");
    expect(glyphPxOrRemembered("youtube", null)).toBe(22);

    resetSiteStyleMemoryForTests();
    store["site_glyph_v1:x"] = { px: 22, at: FROZEN_NOW - TTL_MS - 1 };
    await preloadSiteStyle("x");
    expect(glyphPxOrRemembered("x", null)).toBeNull();
  });
});

describe("rememberSiteStyle - the never-downgrade roundness gate", () => {
  it("persists a fresh read under the literal per-site key, stripping padding", async () => {
    rememberSiteStyle("youtube", { borderRadius: "18px", backgroundColor: "red", paddingInline: "12px" });
    await flushWrites();
    expect(store["site_style_v1:youtube"]).toEqual({ style: { borderRadius: "18px", backgroundColor: "red" }, at: FROZEN_NOW });
  });

  it("never downgrades the durable store to a squarer transient read", async () => {
    rememberSiteStyle("youtube", { borderRadius: "18px" });
    await flushWrites();
    rememberSiteStyle("youtube", { borderRadius: "4px", backgroundColor: "gray" });
    // The squarer read must NOT overwrite the stored pill...
    expect((store["site_style_v1:youtube"] as { style: SiteButtonStyle }).style.borderRadius).toBe("18px");
    // ...but the session cache always tracks the latest read.
    expect(rememberedSiteStyle()).toEqual({ borderRadius: "4px", backgroundColor: "gray" });
  });
});

describe("preferRememberedRadius", () => {
  it("upgrades a squarer fresh read to the remembered pill radius", () => {
    rememberSiteStyle("youtube", { borderRadius: "18px" });
    const fresh: SiteButtonStyle = { borderRadius: "4px" };
    preferRememberedRadius(fresh);
    expect(fresh.borderRadius).toBe("18px");
  });

  it("leaves a read with genuinely no radius alone", () => {
    rememberSiteStyle("youtube", { borderRadius: "18px" });
    const fresh: SiteButtonStyle = { backgroundColor: "red" };
    preferRememberedRadius(fresh);
    expect(fresh.borderRadius).toBeUndefined();
  });
});

describe("glyphPxOrRemembered", () => {
  it("first successful measure is remembered and persisted", async () => {
    expect(glyphPxOrRemembered("youtube", 22)).toBe(22);
    await flushWrites();
    expect(store["site_glyph_v1:youtube"]).toEqual({ px: 22, at: FROZEN_NOW });
  });

  it("a row that measured its own icon paints that, not the remembered size", () => {
    // Regression: a Shorts-first 24px canon mis-sized every 18px watch row - see
    // glyphPxOrRemembered in mount-style-memory.ts.
    expect(glyphPxOrRemembered("youtube", 24)).toBe(24);
    expect(glyphPxOrRemembered("youtube", 18)).toBe(18);
  });

  it("an unmeasurable row falls back to the remembered size", () => {
    glyphPxOrRemembered("youtube", 22);
    expect(glyphPxOrRemembered("youtube", null)).toBe(22);
  });

  it("stays null while nothing has ever been measurable", () => {
    expect(glyphPxOrRemembered("youtube", null)).toBeNull();
  });
});
