// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { firefoxDataConsentManifest } from "../test/fixtures";
import { effectiveAnalyticsConsent, needsLegacyDataConsentNotice, removeTechnicalAndInteractionConsent, requestTechnicalAndInteractionConsent, technicalAndInteractionConsentGranted } from "./data-consent";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("technical and interaction data consent", () => {
  it("keeps analytics enabled when Firefox data consent is not declared", async () => {
    const request = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => ({}) },
      permissions: { request },
    });

    await expect(technicalAndInteractionConsentGranted()).resolves.toBe(true);
    await expect(requestTechnicalAndInteractionConsent()).resolves.toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("requires the Firefox optional data permission when declared", async () => {
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => firefoxDataConsentManifest },
      permissions: {
        getAll: vi.fn((done) =>
          done({
            permissions: [],
            origins: [],
            data_collection: ["technicalAndInteraction"],
          }),
        ),
      },
    });

    await expect(technicalAndInteractionConsentGranted()).resolves.toBe(true);
    await expect(effectiveAnalyticsConsent(true)).resolves.toBe(true);
    await expect(effectiveAnalyticsConsent(false)).resolves.toBe(false);
  });

  it("treats a missing declared optional permission as denied", async () => {
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => firefoxDataConsentManifest },
      permissions: {
        getAll: vi.fn((done) => done({ permissions: [], origins: [], data_collection: [] })),
      },
    });

    await expect(technicalAndInteractionConsentGranted()).resolves.toBe(false);
    await expect(effectiveAnalyticsConsent(true)).resolves.toBe(false);
  });

  it("requests and removes the declared Firefox data permission", async () => {
    const request = vi.fn((_permissions, done: (granted: boolean) => void) => done(true));
    const remove = vi.fn((_permissions, done: (removed: boolean) => void) => done(true));
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => firefoxDataConsentManifest },
      permissions: { request, remove },
    });

    await expect(requestTechnicalAndInteractionConsent()).resolves.toBe(true);
    await expect(removeTechnicalAndInteractionConsent()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ data_collection: ["technicalAndInteraction"] }, expect.any(Function));
    expect(remove).toHaveBeenCalledWith({ data_collection: ["technicalAndInteraction"] }, expect.any(Function));
  });
});

describe("legacy data consent notice", () => {
  const stub = (permissions: unknown, manifest: unknown = firefoxDataConsentManifest) => {
    vi.stubGlobal("chrome", {
      runtime: { getManifest: () => manifest },
      permissions,
    });
  };

  it("is not needed on a build that declares no Firefox data collection", async () => {
    stub({ getAll: vi.fn((done) => done({ permissions: [], origins: [] })) }, {});

    await expect(needsLegacyDataConsentNotice()).resolves.toBe(false);
  });

  it("is not needed when the browser reports the data_collection bucket", async () => {
    stub({ getAll: vi.fn((done) => done({ permissions: [], origins: [], data_collection: [] })) });

    await expect(needsLegacyDataConsentNotice()).resolves.toBe(false);
  });

  // Firefox before 140 (Android before 142) answers getAll without the key entirely.
  it("is needed when the declared bucket is missing from the answer", async () => {
    stub({ getAll: vi.fn((done) => done({ permissions: [], origins: [] })) });

    await expect(needsLegacyDataConsentNotice()).resolves.toBe(true);
  });

  it("stays quiet when the permissions API is unavailable or throws", async () => {
    stub({});
    await expect(needsLegacyDataConsentNotice()).resolves.toBe(false);

    stub({
      getAll: vi.fn(() => {
        throw new Error("nope");
      }),
    });
    await expect(needsLegacyDataConsentNotice()).resolves.toBe(false);
  });
});
