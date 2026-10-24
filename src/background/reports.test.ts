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
  it("posts to /v2/report with the extension's version and no browser fingerprint", async () => {
    stubChrome([]);

    await reportProblem(reportPayload);

    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toMatch(/\/v2\/report$/);
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body).toMatchObject({ event: "report", ...reportPayload, version: "0.1.203" });
    expect(body).not.toHaveProperty("ua");
    expect(init.headers).toMatchObject({ authorization: "Bearer jwt", "accept-language": "uk-UA" });
    expect(init.keepalive).toBe(true);
  });
});
