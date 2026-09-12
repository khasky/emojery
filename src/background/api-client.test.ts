// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, lastFetchCall, stubFetch, stubFetchJson } from "../test/fixtures";
import { ApiHttpError, apiErrorCode, apiErrorString, apiRequest, requestLanguage } from "./api-client";

const ID_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;

let localStore: Record<string, unknown> = {};

beforeEach(() => {
  localStore = installFakeChrome({ id: "a".repeat(32), manifest: { version: "0.1.203" } }).local;
  vi.stubGlobal("navigator", { language: "uk-UA" });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("request shape", () => {
  it("a POST carries the JSON headers, the install id and the encoded body", async () => {
    const fetchMock = stubFetch(async () => new Response("", { status: 202 }));

    await apiRequest("/auth/request-otp", { method: "POST", token: "tok", lang: "uk-UA", body: { email: "a@b.com" }, keepalive: true });

    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toMatch(/\/auth\/request-otp$/);
    expect(init.method).toBe("POST");
    expect(init.keepalive).toBe(true);
    expect(init.body).toBe(JSON.stringify({ email: "a@b.com" }));
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer tok",
      "accept-language": "uk-UA",
      "x-emojery-client": "extension",
      "x-emojery-client-version": "0.1.203",
      "x-emojery-runtime-id": "a".repeat(32),
      "x-emojery-runtime-origin": `chrome-extension://${"a".repeat(32)}`,
      "x-emojery-install-id": expect.stringMatching(ID_SHAPE),
    });
  });

  it("a GET carries the client identity headers only, plus the bearer when given", async () => {
    const fetchMock = stubFetch(async () => new Response("{}", { status: 200 }));

    await apiRequest("/reactions/mine?t=x", { method: "GET", token: "tok", lang: "uk-UA", cache: "no-store" });

    const [, init] = lastFetchCall(fetchMock);
    expect(init.method).toBe("GET");
    expect(init.cache).toBe("no-store");
    expect(init.body).toBeUndefined();
    expect(init.headers).toEqual({
      authorization: "Bearer tok",
      "x-emojery-client": "extension",
      "x-emojery-client-version": "0.1.203",
      "x-emojery-runtime-id": "a".repeat(32),
      "x-emojery-runtime-origin": `chrome-extension://${"a".repeat(32)}`,
    });
  });

  it("omits accept-language and the bearer when neither is given", async () => {
    const fetchMock = stubFetch(async () => new Response(null, { status: 204 }));

    await apiRequest("/auth/logout", { method: "POST" });

    const [, init] = lastFetchCall(fetchMock);
    expect(init.headers).not.toHaveProperty("accept-language");
    expect(init.headers).not.toHaveProperty("authorization");
    expect(init.headers).toHaveProperty("content-type", "application/json");
  });

  it("gives every request a deadline, and keeps a caller's own signal", async () => {
    const fetchMock = stubFetch(async () => new Response(null, { status: 204 }));

    await apiRequest("/reactions/popular", { method: "GET" });
    expect(lastFetchCall(fetchMock)[1].signal).toBeInstanceOf(AbortSignal);

    const own = new AbortController().signal;
    await apiRequest("/reactions/count", { method: "GET", signal: own });
    expect(lastFetchCall(fetchMock)[1].signal).toBe(own);
  });

  it("rethrows a failed fetch", async () => {
    stubFetch(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(apiRequest("/reactions/popular", { method: "GET" })).rejects.toThrow("Failed to fetch");
  });
});

describe("reply", () => {
  it("decodes a JSON body and reports the status", async () => {
    stubFetchJson(200, { emojis: ["🔥"] });
    await expect(apiRequest("/reactions/popular", { method: "GET" })).resolves.toEqual({ ok: true, status: 200, body: { emojis: ["🔥"] } });
  });

  it("reads an empty body as null", async () => {
    stubFetch(async () => new Response(null, { status: 204 }));
    await expect(apiRequest("/auth/logout", { method: "POST" })).resolves.toEqual({ ok: true, status: 204, body: null });
  });

  it("reads a non-JSON body as null, tracing the one a 2xx carried", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    stubFetchJson(200, "<html>");
    await expect(apiRequest("/reactions/count", { method: "GET" })).resolves.toMatchObject({ ok: true, body: null });
    expect(error).toHaveBeenCalledWith("[emojery:error]", expect.objectContaining({ scope: "apiRequest.parseBody" }));

    error.mockClear();
    stubFetchJson(502, "bad gateway");
    await expect(apiRequest("/reactions/count", { method: "GET" })).resolves.toMatchObject({ ok: false, status: 502, body: null });
    expect(error).not.toHaveBeenCalled();
  });

  it("surfaces the error string a refused request answers with", async () => {
    stubFetchJson(429, { error: "rate_limited" });
    const reply = await apiRequest("/auth/request-otp", { method: "POST", body: {} });
    expect(apiErrorString(reply.body)).toBe("rate_limited");
    expect(apiErrorString({ error: "" })).toBeUndefined();
    expect(apiErrorString({ error: 7 })).toBeUndefined();
    expect(apiErrorString(null)).toBeUndefined();
  });
});

describe("Retry-After", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.UTC(2026, 7, 4, 0, 0, 0) });
  });

  async function retryAfter(header: string | undefined): Promise<number | undefined> {
    stubFetchJson(429, {}, header === undefined ? undefined : { "retry-after": header });
    return (await apiRequest("/reactions/count", { method: "GET" })).retryAfterSeconds;
  }

  it("parses delta-seconds", async () => {
    expect(await retryAfter("0")).toBe(0);
    expect(await retryAfter("120")).toBe(120);
    expect(await retryAfter(" 120 ")).toBe(120);
    expect(await retryAfter("00")).toBe(0);
  });

  it("parses an HTTP-date relative to now, clamped at zero", async () => {
    expect(await retryAfter("Tue, 04 Aug 2026 00:01:30 GMT")).toBe(90);
    expect(await retryAfter("Mon, 03 Aug 2026 23:59:00 GMT")).toBe(0);
  });

  it("drops a malformed or missing header", async () => {
    expect(await retryAfter("soon")).toBeUndefined();
    expect(await retryAfter("")).toBeUndefined();
    expect(await retryAfter(undefined)).toBeUndefined();
  });

  it("clamps a negative delta at zero", async () => {
    expect(await retryAfter("-5")).toBe(0);
  });
});

describe("error classification", () => {
  it("tells rate-limited from server-down from unavailable from offline", () => {
    expect(apiErrorCode(new ApiHttpError(429))).toBe("rate_limited");
    expect(apiErrorCode(new ApiHttpError(503))).toBe("server");
    expect(apiErrorCode(new ApiHttpError(404))).toBe("unavailable");
    expect(apiErrorCode(new TypeError("Failed to fetch"))).toBe("network");
  });
});

describe("requestLanguage", () => {
  it("keeps a well-formed tag with its region and drops a malformed one", () => {
    expect(requestLanguage()).toBe("uk-UA");
    vi.stubGlobal("navigator", { language: "pt-BR" });
    expect(requestLanguage()).toBe("pt-BR");
    vi.stubGlobal("navigator", { language: "not a tag!" });
    expect(requestLanguage()).toBeUndefined();
  });
});

// The install id goes straight out as a request header, and storage.local is not a
// trusted store: an older build, a synced profile or a hand-edited one can leave
// anything under its key.
describe("install id", () => {
  async function sentInstallId(): Promise<string> {
    const fetchMock = stubFetch(async () => new Response(null, { status: 204 }));
    await apiRequest("/auth/logout", { method: "POST" });
    return (lastFetchCall(fetchMock)[1].headers as Record<string, string>)["x-emojery-install-id"]!;
  }

  it("mints one id and keeps it across requests", async () => {
    const first = await sentInstallId();
    const second = await sentInstallId();
    expect(first).toMatch(ID_SHAPE);
    expect(second).toBe(first);
    expect(localStore.security_context_v1).toEqual({ installId: first });
  });

  it("drops the session fields an older build stored, keeping the install id", async () => {
    localStore.security_context_v1 = { installId: "install_1234567890abcdef", sessionId: "session_1234567890abcdef", sessionStartedAt: 1000 };

    expect(await sentInstallId()).toBe("install_1234567890abcdef");
    expect(localStore.security_context_v1).toEqual({ installId: "install_1234567890abcdef" });
  });

  const GOOD = "install_1234567890abcdef";

  // Each one is a value randomId() cannot emit.
  const malformed: Array<[string, unknown]> = [
    ["one char short of the minimum", "a".repeat(15)],
    ["one char past the maximum", "a".repeat(129)],
    ["empty", ""],
    ["blank", "   "],
    ["a path separator", "install/1234567890abcd"],
    ["a header separator", "install\r\nx-injected: 1"],
    ["a space inside", "install 1234567890abcd"],
    ["a non-ASCII letter", "instаll_1234567890abcdef"],
    ["a number", 1234567890123456],
    ["an object", { id: GOOD }],
    ["null", null],
    ["an array", [GOOD]],
  ];

  for (const [label, stored] of malformed) {
    it(`replaces an install id stored as ${label}, and persists the replacement`, async () => {
      localStore.security_context_v1 = { installId: stored };

      const sent = await sentInstallId();

      expect(sent).not.toEqual(stored);
      expect(sent).toMatch(ID_SHAPE);
      expect((localStore.security_context_v1 as { installId: string }).installId).toBe(sent);
    });
  }

  it("keeps a stored id that already has the shape, at either length bound", async () => {
    for (const id of ["a".repeat(16), "a".repeat(128), "A-Za-z0-9_-0123456789"]) {
      localStore.security_context_v1 = { installId: id };
      expect(await sentInstallId(), id).toBe(id);
    }
  });

  it("accepts a padded id by trimming it rather than minting a new installation", async () => {
    localStore.security_context_v1 = { installId: `  ${GOOD}\n` };
    expect(await sentInstallId()).toBe(GOOD);
    // The trimmed form is what gets persisted, so the padding is not judged again.
    expect(localStore.security_context_v1).toEqual({ installId: GOOD });
  });
});
