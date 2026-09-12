// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { firefoxDataConsentManifest, installFakeChrome, lastFetchCall, stubFetch } from "../test/fixtures";

vi.mock("./identity", () => ({
  getAuth: vi.fn(),
}));

import { getAuth } from "./identity";
import { reportProblem } from "./reports";

const reportPayload = {
  site: "facebook",
  host: "www.facebook.com",
  url: "https://www.facebook.com/zuck/posts/1",
  targetCount: 1,
  note: "missing button",
};

function stubChrome(dataCollection: string[]): void {
  installFakeChrome({ manifest: { version: "0.1.203", ...firefoxDataConsentManifest }, dataCollection });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = stubFetch(async () => new Response("", { status: 200 }));
  vi.stubGlobal("navigator", {
    userAgent: "Mozilla/5.0 Test",
    language: "uk-UA",
  });
  vi.mocked(getAuth).mockResolvedValue({
    userId: "u1",
    token: "jwt",
    expiresAt: 9999999999,
  } as Awaited<ReturnType<typeof getAuth>>);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reportProblem outcome", () => {
  // The popup shows a success screen on `true`. A report that never reached the
  // server must not produce one.
  it("reports true only when the POST landed", async () => {
    stubChrome([]);
    await expect(reportProblem(reportPayload)).resolves.toBe(true);
  });

  it("reports false on a non-ok response", async () => {
    stubChrome([]);
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    await expect(reportProblem(reportPayload)).resolves.toBe(false);
  });

  it("reports false when the request throws", async () => {
    stubChrome([]);
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(reportProblem(reportPayload)).resolves.toBe(false);
  });

  it("reports false when the session is gone", async () => {
    stubChrome([]);
    vi.mocked(getAuth).mockResolvedValue(null);
    await expect(reportProblem(reportPayload)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("reportProblem", () => {
  it("includes explicit technical fields when Firefox consent is granted", async () => {
    stubChrome(["technicalAndInteraction"]);

    await reportProblem(reportPayload);

    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toMatch(/\/report$/);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: "report",
      ...reportPayload,
      ua: "Mozilla/5.0 Test",
      version: "0.1.203",
    });
    expect(init.headers).toMatchObject({
      "x-emojery-client": "extension",
      "accept-language": "uk-UA",
    });
  });

  it("omits explicit technical fields when Firefox consent is denied", async () => {
    stubChrome([]);

    await reportProblem(reportPayload);

    const [, init] = lastFetchCall(fetchMock);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: "report",
      ...reportPayload,
    });
    expect(body).not.toHaveProperty("ua");
    expect(body).not.toHaveProperty("version");
    // The session token and the UI language ride as headers, as on every JSON POST.
    expect(init.headers).toMatchObject({
      authorization: "Bearer jwt",
      "x-emojery-client": "extension",
      "accept-language": "uk-UA",
    });
    expect(init.keepalive).toBe(true);
  });
});
