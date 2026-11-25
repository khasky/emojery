// SPDX-License-Identifier: GPL-3.0-or-later
//
// The log pins: each deployment's log name and signing key, and the origin switch that trusts
// only a rewind record signed by that key. The staging records are the published ones from
// https://log-staging.emojery.app/index.json, so the pinned staging key is checked against
// signatures the staging log really made.
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../test/cold-module-reset";

allowColdModuleReset();

// The published log public keys, in the shape LOG_PUBKEYS has.
const PINNED = {
  production: "z0z5ZBrlz67P2+FD+kz5ayXyFQyCCB2rQzPxPUtery4=",
  staging: "P37N5YTTgfbn4L1oW4lLnQM7BsHQEYgY4QpnkYLNEaM=",
} as const;

// The first two rewind records of the staging log, as published.
const STAGING_REWINDS = [
  "emojery-rewind-v1\nlog-staging.emojery.app/g1\nlog-staging.emojery.app/g0\n1792885238394\n0\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\n18\n9sslimOhIqVj1n7qY9UaTz2iiFZVOM+9ZWutC60Pz88=\nrehearsal: M2 exit, rewind to g1\n\n\u2014 log-staging.emojery.app J8ukzUV+2UCAwU3Nxv2e6mLlj1LsQ+9XqHlEyXUHUfc8vbPnAg5aBd4f42q/DKAUYGVfAN9e0vZDZnASA1UmVogh0Aw=\n",
  "emojery-rewind-v1\nlog-staging.emojery.app/g2\nlog-staging.emojery.app/g1\n1793658364543\n0\n47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=\n54311\n8AzGtiS/1hXLmuv0IkgvTUQ2GWWalbdbGebi+4A60S0=\nstaging reset\n\n\u2014 log-staging.emojery.app J8ukzahvwQ1bGqGi0aSmV0OMG2Ni91fkfq9xxSR25JEPw7/e7lp5PARsvgAVU6leFqwVjs+ix5E9MpSrMOoEcCxE+Qs=\n",
];

function indexFetcher(records: { kind: string; note: string }[]) {
  return vi.fn(async (_url: string) => new Response(JSON.stringify({ records }), { status: 200 }));
}

async function loadFor(apiBase: string) {
  vi.resetModules();
  vi.doMock("../shared/config", () => ({ API_BASE: apiBase }));
  vi.doMock("./debug", () => ({ logBackgroundError: vi.fn() }));
  const deployment = await import("../shared/deployment");
  const { originIsSigned } = await import("./origin-switch");
  return { ...deployment, originIsSigned };
}

afterEach(() => {
  vi.doUnmock("../shared/config");
  vi.doUnmock("./debug");
});

describe("log pins", () => {
  it("pin a 32-byte Ed25519 key for each deployment", async () => {
    const { LOG_PUBKEYS } = await loadFor("https://api-staging.emojery.app");
    expect(LOG_PUBKEYS).toEqual({ production: PINNED.production, staging: PINNED.staging });
    for (const key of Object.values(LOG_PUBKEYS)) {
      const raw = Uint8Array.from(atob(key), (c) => c.charCodeAt(0));
      expect(raw).toHaveLength(32);
      await expect(crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"])).resolves.toBeDefined();
    }
  });

  it("give a production build the production log's name, host and key", async () => {
    const d = await loadFor("https://api.emojery.app");
    expect(d.DEPLOYMENT).toBe("production");
    expect(d.LOG_NAME).toBe("log.emojery.app");
    expect(d.LOG_BASE_URL).toBe("https://log.emojery.app");
    expect(d.INITIAL_ORIGIN).toBe("log.emojery.app/g0");
    expect(d.LOG_PUBKEY).toBe(PINNED.production);
  });

  it("give a staging build the staging log's name, host and key", async () => {
    const d = await loadFor("https://api-staging.emojery.app");
    expect(d.DEPLOYMENT).toBe("staging");
    expect(d.LOG_NAME).toBe("log-staging.emojery.app");
    expect(d.LOG_BASE_URL).toBe("https://log-staging.emojery.app");
    expect(d.LOG_PUBKEY).toBe(PINNED.staging);
  });
});

describe("originIsSigned", () => {
  const records = STAGING_REWINDS.map((note) => ({ kind: "rewind", note }));

  it("takes an origin a staging rewind record signed by the pinned key opens", async () => {
    const { originIsSigned } = await loadFor("https://api-staging.emojery.app");
    const fetcher = indexFetcher(records);
    await expect(originIsSigned("log-staging.emojery.app/g2", fetcher as unknown as typeof fetch)).resolves.toBe(true);
    expect(fetcher).toHaveBeenCalledWith("https://log-staging.emojery.app/index.json", expect.anything());
  });

  it("refuses an origin no record opens, and a record whose text was changed", async () => {
    const { originIsSigned } = await loadFor("https://api-staging.emojery.app");
    await expect(originIsSigned("log-staging.emojery.app/g9", indexFetcher(records) as unknown as typeof fetch)).resolves.toBe(false);
    const forged = records.map((r) => ({ ...r, note: r.note.replace("/g2\n", "/g9\n") }));
    await expect(originIsSigned("log-staging.emojery.app/g9", indexFetcher(forged) as unknown as typeof fetch)).resolves.toBe(false);
  });

  it("reads the production log in a production build and trusts no staging signature there", async () => {
    const { originIsSigned } = await loadFor("https://api.emojery.app");
    const fetcher = indexFetcher(records.map((r) => ({ ...r, note: r.note.replaceAll("log-staging.emojery.app", "log.emojery.app") })));
    await expect(originIsSigned("log.emojery.app/g2", fetcher as unknown as typeof fetch)).resolves.toBe(false);
    expect(fetcher).toHaveBeenCalledWith("https://log.emojery.app/index.json", expect.anything());
  });
});
