// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { firefoxDataConsentManifest } from "../test/fixtures";
import { needsLegacyDataConsentNotice } from "./data-consent";

afterEach(() => {
  vi.unstubAllGlobals();
});

const stub = (permissions: unknown, manifest: unknown = firefoxDataConsentManifest) => {
  vi.stubGlobal("chrome", {
    runtime: { getManifest: () => manifest },
    permissions,
  });
};

describe("legacy data consent notice", () => {
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
