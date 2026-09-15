// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { BUILD_INDEX_PATH, buildRequestProof, challengeExpiryMs, measureBuild, measuredBytes, parseBuildIndex } from "./build-context";

const ID = "a".repeat(64);

function index(files: string[]) {
  return { format: 1, id: ID, files };
}

const VALID_FILES = [BUILD_INDEX_PATH, "chunks/background.js", "manifest.json"].sort();

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text);

describe("parseBuildIndex", () => {
  it("accepts a sorted index naming the manifest and itself", () => {
    expect(parseBuildIndex(index(VALID_FILES)).files).toEqual(VALID_FILES);
  });

  it.each([
    ["a foreign format", { format: 2, id: ID, files: VALID_FILES }],
    ["an id that is not a digest", { format: 1, id: "nope", files: VALID_FILES }],
    ["no manifest", index([BUILD_INDEX_PATH, "chunks/background.js"])],
    ["no index of its own", index(["chunks/background.js", "manifest.json"])],
  ])("refuses %s", (_name, value) => {
    expect(() => parseBuildIndex(value)).toThrow();
  });

  it.each([
    ["an unsorted list", ["manifest.json", BUILD_INDEX_PATH, "chunks/background.js"]],
    ["a repeated path", [BUILD_INDEX_PATH, "manifest.json", "manifest.json"]],
    ["a traversal", [BUILD_INDEX_PATH, "manifest.json", "x/../../secrets"]],
    ["an absolute path", ["/etc/passwd", BUILD_INDEX_PATH, "manifest.json"]],
  ])("refuses %s", (_name, files) => {
    expect(() => parseBuildIndex(index(files))).toThrow();
  });
});

describe("measuredBytes", () => {
  it("drops the fields a store stamps into the manifest after packaging", async () => {
    const shipped = measuredBytes("manifest.json", bytes(JSON.stringify({ name: "Emojery", version: "1.0.0" })));
    const installed = measuredBytes("manifest.json", bytes(JSON.stringify({ version: "1.0.0", name: "Emojery", key: "MIIBIj", update_url: "https://clients2.google.com/service/update2/crx", differential_fingerprint: "1.abc" })));
    expect(new TextDecoder().decode(installed)).toBe(new TextDecoder().decode(shipped));
  });

  it("leaves every other file byte-for-byte", () => {
    const raw = bytes('{"key":"kept"}');
    expect(measuredBytes("chunks/background.js", raw)).toBe(raw);
  });
});

describe("measureBuild", () => {
  const read = (contents: Record<string, string>) => (path: string) => Promise.resolve(bytes(contents[path] ?? ""));
  const contents = { [BUILD_INDEX_PATH]: "{}", "chunks/background.js": "console.log(1)", "manifest.json": '{"version":"1.0.0"}' };

  it("changes when one packaged byte changes", async () => {
    const before = await measureBuild(parseBuildIndex(index(VALID_FILES)), read(contents));
    const after = await measureBuild(parseBuildIndex(index(VALID_FILES)), read({ ...contents, "chunks/background.js": "console.log(2)" }));
    expect(after).not.toBe(before);
  });

  it("survives the manifest a store rewrote", async () => {
    const before = await measureBuild(parseBuildIndex(index(VALID_FILES)), read(contents));
    const installed = { ...contents, "manifest.json": '{"key":"MIIBIj","version":"1.0.0"}' };
    expect(await measureBuild(parseBuildIndex(index(VALID_FILES)), read(installed))).toBe(before);
  });

  it("refuses a file past the per-file ceiling", async () => {
    const huge = () => Promise.resolve(new Uint8Array(17 * 1024 * 1024));
    await expect(measureBuild(parseBuildIndex(index(VALID_FILES)), huge)).rejects.toThrow();
  });
});

describe("challengeExpiryMs", () => {
  const challenge = (claims: unknown) => `v1.${btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.mac`;

  it("reads the expiry out of the payload", () => {
    expect(challengeExpiryMs(challenge({ exp: 1_700_000_000, n: "00" }))).toBe(1_700_000_000_000);
  });

  it.each([
    ["a token with no payload", "v1"],
    ["a payload that is not JSON", "v1.bm90LWpzb24.mac"],
    ["a payload with no expiry", challenge({ n: "00" })],
  ])("reads %s as no expiry", (_name, value) => {
    expect(challengeExpiryMs(value)).toBeNull();
  });
});

// The backend pins the same vector. A red test here means the two halves have to ship
// together, never that the value needs regenerating.
describe("buildRequestProof", () => {
  it("pins the serialization shared with the backend", async () => {
    const proof = await buildRequestProof(ID, "b".repeat(64), "v1.fixed-challenge.mac", "https://api.emojery.app/reactions/vote", "POST", "");
    expect(proof).toBe("ffc5978f15cf8978f3af112a5c29fc2955b5a7c89e7a135d36896dcd7933348a");
  });

  it("differs per challenge, per endpoint, per method and per token", async () => {
    const base = ["v1.c.mac", "https://api.emojery.app/reactions/vote", "POST", ""] as const;
    const proof = (...args: [string, string, string, string]) => buildRequestProof(ID, "b".repeat(64), ...args);
    const [answer, other, elsewhere, read, authed] = await Promise.all([proof(...base), proof("v1.d.mac", base[1], base[2], base[3]), proof(base[0], "https://api.emojery.app/reactions/count", base[2], base[3]), proof(base[0], base[1], "GET", base[3]), proof(base[0], base[1], base[2], "Bearer token")]);
    expect(new Set([answer, other, elsewhere, read, authed]).size).toBe(5);
  });
});
