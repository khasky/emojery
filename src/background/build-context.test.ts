// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILD_ID_HEADER, BUILD_INDEX_PATH, BUILD_TAG_HEADER, buildRequestTag } from "../shared/build-context";
import { installFakeChrome, stubFetch } from "../test/fixtures";
import { buildTagHeaders, rememberBuildRef, resetBuildContext } from "./build-context";

const ID = "a".repeat(64);
const PACKAGE: Record<string, string> = {
  "chunks/background.js": "console.log(1)",
  "manifest.json": '{"version":"1.0.0"}',
};
const INDEX = JSON.stringify({ format: 1, id: ID, files: [BUILD_INDEX_PATH, ...Object.keys(PACKAGE)].sort() });

const URL_UNDER_TEST = "https://api.emojery.app/reactions/vote";

function refFor(secondsFromNow: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + secondsFromNow, n: "00" }));
  return `v1.${payload.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.mac`;
}

// Serves the fake package off `chrome-extension://<id>/<path>`, counting the reads so
// a cached measurement shows up as the absence of a second pass.
function stubPackage(overrides: Record<string, string> = {}): { reads: string[] } {
  const files: Record<string, string> = { [BUILD_INDEX_PATH]: INDEX, ...PACKAGE, ...overrides };
  const reads: string[] = [];
  stubFetch(async (input) => {
    const path = String(input).replace(/^chrome-extension:\/\/[^/]+\//, "");
    reads.push(path);
    const body = files[path];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  });
  return { reads };
}

/** Polled: the measurement runs off the request path, so the first call returns
 *  nothing. */
async function settledHeaders(url = URL_UNDER_TEST, method = "POST", authorization = ""): Promise<Record<string, string>> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const headers = await buildTagHeaders(url, method, authorization);
    if (headers[BUILD_ID_HEADER]) return headers;
  }
  return {};
}

let session: Record<string, unknown>;

beforeEach(() => {
  resetBuildContext();
  session = installFakeChrome({ id: "b".repeat(32) }).session;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildTagHeaders", () => {
  it("sends nothing until a response has handed one out", async () => {
    stubPackage();
    expect(await buildTagHeaders(URL_UNDER_TEST, "POST", "")).toEqual({});
  });

  it("answers with the measured package", async () => {
    stubPackage();
    rememberBuildRef(refFor(600));
    const headers = await settledHeaders();
    expect(headers[BUILD_ID_HEADER]).toBe(ID);
    const [ref, tag] = (headers[BUILD_TAG_HEADER] ?? "").split("~");
    expect(tag).toMatch(/^[a-f0-9]{64}$/);
    expect(ref).toBe(refFor(600));
  });

  it("binds the answer to the request it rides on", async () => {
    stubPackage();
    rememberBuildRef(refFor(600));
    const vote = await settledHeaders();
    const read = await buildTagHeaders("https://api.emojery.app/reactions/count", "GET", "");
    expect(read[BUILD_TAG_HEADER]).not.toBe(vote[BUILD_TAG_HEADER]);
  });

  it("measures the package once per session and re-answers from the cache", async () => {
    const { reads } = stubPackage();
    rememberBuildRef(refFor(600));
    await settledHeaders();
    const afterFirst = reads.length;
    expect(afterFirst).toBeGreaterThan(1);

    // A restarted service worker keeps storage.session, so the second pass reads only
    // the index.
    resetBuildContext();
    rememberBuildRef(refFor(600));
    await settledHeaders();
    expect(reads.slice(afterFirst)).toEqual([BUILD_INDEX_PATH]);
  });

  it("stops answering once the ref expires", async () => {
    stubPackage();
    rememberBuildRef(refFor(600));
    await settledHeaders();
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 600_000);
    expect(await buildTagHeaders(URL_UNDER_TEST, "POST", "")).toEqual({});
    vi.useRealTimers();
  });

  it.each([
    ["one already spent", -10],
    ["one dated further ahead than the server would issue", 7200],
  ])("ignores a ref %s", async (_name, seconds) => {
    stubPackage();
    rememberBuildRef(refFor(seconds));
    expect(await buildTagHeaders(URL_UNDER_TEST, "POST", "")).toEqual({});
    expect(session).toEqual({});
  });

  it("stays quiet when the package carries no index", async () => {
    stubFetch(async () => new Response("", { status: 404 }));
    rememberBuildRef(refFor(600));
    expect(await settledHeaders()).toEqual({});
  });

  it("stays quiet when a listed file is missing", async () => {
    const files: Record<string, string> = { [BUILD_INDEX_PATH]: INDEX, "manifest.json": PACKAGE["manifest.json"] ?? "" };
    stubFetch(async (input) => {
      const path = String(input).replace(/^chrome-extension:\/\/[^/]+\//, "");
      const body = files[path];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body);
    });
    rememberBuildRef(refFor(600));
    expect(await settledHeaders()).toEqual({});
  });

  it("re-measures rather than trusting a cached digest from another build", async () => {
    session.build_measurement_v1 = { id: ID, root: "c".repeat(64) };
    const { reads } = stubPackage();
    rememberBuildRef(refFor(600));
    const headers = await settledHeaders();
    // The cached digest is keyed by the index id, so this one is used as-is...
    expect(reads).toEqual([BUILD_INDEX_PATH]);
    const expected = await buildRequestTag(ID, "c".repeat(64), refFor(600), URL_UNDER_TEST, "POST", "");
    expect(headers[BUILD_TAG_HEADER]).toBe(`${refFor(600)}~${expected}`);

    // ...and a package whose index names a different build is measured again.
    resetBuildContext();
    const other = JSON.stringify({ format: 1, id: "d".repeat(64), files: [BUILD_INDEX_PATH, ...Object.keys(PACKAGE)].sort() });
    const second = stubPackage({ [BUILD_INDEX_PATH]: other });
    rememberBuildRef(refFor(600));
    expect((await settledHeaders())[BUILD_ID_HEADER]).toBe("d".repeat(64));
    expect(second.reads.length).toBeGreaterThan(1);
  });
});
