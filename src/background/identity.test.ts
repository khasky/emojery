// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, lastFetchCall, stubFetch, stubFetchJson } from "../test/fixtures";

// Frozen clock: session expiry compares `expiresAt * 1000` against Date.now(),
// so the boundary cases below are exact only against a constant clock.
const FROZEN_NOW = Date.UTC(2026, 0, 1);
const FROZEN_SEC = FROZEN_NOW / 1000;

// History lives in IndexedDB (absent under jsdom); its wipe semantics are
// covered by history.browser.test.ts - here only WHICH wipe runs matters.
const clearHistory = vi.fn(async () => {});
const clearHistoryForUser = vi.fn(async (_userId: string) => {});
vi.mock("./history", () => ({
  clearHistory: () => clearHistory(),
  clearHistoryForUser: (userId: string) => clearHistoryForUser(userId),
}));

import { deleteAccount, finishPendingDeletion, getAuth, requestOtp, revokeSessionServerSide, verifyOtp } from "./identity";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearHistory.mockClear();
  clearHistoryForUser.mockClear();
});

describe("requestOtp", () => {
  it("returns ok on a 2xx", async () => {
    stubFetchJson(200, "");
    expect(await requestOtp("a@b.com")).toEqual({ ok: true, status: 200 });
  });

  it("surfaces Retry-After header seconds on a 429", async () => {
    stubFetchJson(429, { error: "rate limited" }, { "retry-after": "90" });
    expect(await requestOtp("a@b.com")).toMatchObject({
      ok: false,
      status: 429,
      retryAfterSeconds: 90,
    });
  });

  // The header is the only source the client reads; a delay in the body is not
  // part of the response contract.
  it("ignores a retry value in the response body", async () => {
    stubFetchJson(429, { error: "rate limited", retry_after: 45 });
    expect((await requestOtp("a@b.com")).retryAfterSeconds).toBeUndefined();
  });

  it("omits retryAfterSeconds when the header is absent", async () => {
    stubFetchJson(429, {});
    expect((await requestOtp("a@b.com")).retryAfterSeconds).toBeUndefined();
  });

  it("ignores a malformed Retry-After header", async () => {
    stubFetchJson(429, {}, { "retry-after": "soon-ish" });
    expect((await requestOtp("a@b.com")).retryAfterSeconds).toBeUndefined();
  });

  it("sends cross-browser extension source headers", async () => {
    const fetchMock = stubFetch(async () => new Response("", { status: 202 }));
    vi.stubGlobal("navigator", { language: "uk-UA" });
    installFakeChrome({ id: "a".repeat(32), manifest: { version: "0.1.203" } });

    await requestOtp("a@b.com");

    const [, init] = lastFetchCall(fetchMock);
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "accept-language": "uk-UA",
      "x-emojery-client": "extension",
      "x-emojery-client-version": "0.1.203",
      "x-emojery-runtime-id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "x-emojery-runtime-origin": "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(init.headers).toMatchObject({
      "x-emojery-install-id": expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
      "x-emojery-session-id": expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
    });
    expect(JSON.parse(init.body as string)).toEqual({
      email: "a@b.com",
      lang: "uk-UA",
    });
  });
});

// Pins the seconds-vs-milliseconds contract: the wire field is `expiresAtSec`,
// the stored `expiresAt` carries the same unit (rationale in identity.ts).
describe("verifyOtp - session wire contract", () => {
  it("stores the session from `expiresAtSec` (unix seconds)", async () => {
    const expiresAtSec = FROZEN_SEC + 3600;
    installFakeChrome({ id: "a".repeat(32), manifest: { version: "0.1.0" } });
    stubFetchJson(200, { userId: "u1", token: "tok-123", expiresAtSec });

    const res = await verifyOtp("a@b.com", "123456");

    expect(res).toMatchObject({ ok: true, status: 200 });
    expect(await getAuth()).toEqual({ userId: "u1", token: "tok-123", expiresAt: expiresAtSec, email: "a@b.com" });
  });

  it("rejects a session body without the expiry rather than storing a broken one", async () => {
    installFakeChrome({ id: "a".repeat(32), manifest: { version: "0.1.0" } });
    stubFetchJson(200, { userId: "u1", token: "tok-123" });

    expect(await verifyOtp("a@b.com", "123456")).toMatchObject({ ok: false, error: "invalid_session" });
    expect(await getAuth()).toBeNull();
  });
});

function setupChrome(
  initial: Record<string, unknown> = {},
  sessionInitial: Record<string, unknown> = {},
): {
  store: Record<string, unknown>;
  session: Record<string, unknown>;
  fetchMock: ReturnType<typeof vi.fn>;
} {
  vi.stubGlobal("navigator", { language: "en-US" });
  const { local: store, session } = installFakeChrome({ local: initial, session: sessionInitial, id: "a".repeat(32), manifest: { version: "0.1.0" } });
  const fetchMock = stubFetch(async () => new Response(null, { status: 204 }));
  return { store, session, fetchMock };
}

const AUTH = {
  userId: "u1",
  token: "tok-123",
  expiresAt: FROZEN_SEC + 99_999,
  email: "a@b.com",
};

describe("getAuth - session expiry boundary", () => {
  it("returns the session while it is still valid (one second before expiry)", async () => {
    setupChrome({ auth_v1: { ...AUTH, expiresAt: FROZEN_SEC + 1 } });
    expect(await getAuth()).toMatchObject({ userId: "u1" });
  });

  it("drops an expired session: null AND the stored record removed", async () => {
    const { store } = setupChrome({ auth_v1: { ...AUTH, expiresAt: FROZEN_SEC - 1 } });
    expect(await getAuth()).toBeNull();
    expect(store.auth_v1).toBeUndefined();
  });
});

// A local clear is not a sign-out - the server call is what ends the session. Both must run.
describe("server-side session revocation", () => {
  it("POSTs /auth/logout with the bearer token and keepalive", async () => {
    const { fetchMock } = setupChrome({ auth_v1: AUTH });

    expect(await revokeSessionServerSide("tok-123")).toBe(true);

    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toContain("/auth/logout");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(init.keepalive).toBe(true);
  });

  it("counts a 401 as revoked and reports any other failure", async () => {
    const { fetchMock } = setupChrome({ auth_v1: AUTH });

    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    expect(await revokeSessionServerSide("tok-123")).toBe(true);

    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    expect(await revokeSessionServerSide("tok-123")).toBe(false);

    fetchMock.mockRejectedValue(new Error("offline"));
    expect(await revokeSessionServerSide("tok-123")).toBe(false);
  });
});

describe("account deletion", () => {
  // Deleting ONE account must not take a second account's device-local records
  // with it - the other account is still signed in on this browser.
  it("on 204: POSTs with bearer + keepalive, then wipes only the deleted account's local state", async () => {
    const { store, fetchMock } = setupChrome({
      auth_v1: AUTH,
      own_reactions_v2: {
        "facebook:1": { reaction: "❤️", userId: "u1" },
        "facebook:2": { reaction: "🔥", userId: "u2" },
      },
      auto_native_v1: {
        "facebook:1": { action: "like", userId: "u1" },
        "facebook:2": { action: "like", userId: "u2" },
      },
    });

    const ok = await deleteAccount();

    expect(ok).toBe(true);
    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toContain("/auth/delete");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-123");
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(init.body as string)).toMatchObject({ email: "a@b.com" });
    expect(store.auth_v1).toBeUndefined();
    expect(clearHistoryForUser).toHaveBeenCalledWith("u1");
    expect(clearHistory).not.toHaveBeenCalled();
    expect(store.own_reactions_v2).toEqual({ "facebook:2": { reaction: "🔥", userId: "u2" } });
    expect(store.auto_native_v1).toEqual({ "facebook:2": { action: "like", userId: "u2" } });
    expect(store.deletion_pending_v1).toBeUndefined();
  });

  it("on transient failure (500): keeps the session and persists a pending marker naming the account", async () => {
    const { store, session, fetchMock } = setupChrome({ auth_v1: AUTH });
    fetchMock.mockResolvedValue(new Response(null, { status: 500 }));

    const ok = await deleteAccount();

    expect(ok).toBe(false);
    expect(store.auth_v1).toEqual(AUTH); // still signed in - not stranded
    expect(session.deletion_pending_v1).toEqual({ token: "tok-123", userId: "u1", email: "a@b.com", expiresAt: AUTH.expiresAt }); // retry later, still scoped
  });

  // The marker is the one place a bearer token survives clearAuth(), so it must not
  // outlive the token: past the expiry it is dropped unread instead of being retried.
  it("finishPendingDeletion drops an expired marker without sending anything", async () => {
    const { store, fetchMock } = setupChrome({
      deletion_pending_v1: { token: "tok-stale", userId: "u9", email: "u9@b.com", expiresAt: FROZEN_SEC - 1 },
    });

    expect(await finishPendingDeletion()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.deletion_pending_v1).toBeUndefined();
  });

  it("omits the address for a session that has none", async () => {
    const { fetchMock } = setupChrome({ auth_v1: { userId: "u1", token: "tok-123", expiresAt: FROZEN_SEC + 99_999 } });

    expect(await deleteAccount()).toBe(true);

    const [, init] = lastFetchCall(fetchMock);
    expect(JSON.parse(init.body as string)).not.toHaveProperty("email");
  });

  it("finishPendingDeletion drains a pending marker; 401 (already erased) counts as done", async () => {
    const { store, session, fetchMock } = setupChrome({ own_reactions_v2: { "facebook:2": { reaction: "🔥", userId: "u2" } } }, { deletion_pending_v1: { token: "tok-xyz", userId: "u9", email: "u9@b.com" } });
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const ok = await finishPendingDeletion();

    expect(ok).toBe(true);
    const [, init] = lastFetchCall(fetchMock);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-xyz");
    expect(JSON.parse(init.body as string)).toMatchObject({ email: "u9@b.com" });
    expect(session.deletion_pending_v1).toBeUndefined();
    expect(clearHistoryForUser).toHaveBeenCalledWith("u9");
    expect(store.own_reactions_v2).toEqual({ "facebook:2": { reaction: "🔥", userId: "u2" } });
  });

  // A marker written before the field existed names no account, so the scoped
  // delete is impossible and the old wholesale history wipe is the fallback.
  it("finishPendingDeletion falls back to the wholesale wipe for a marker with no userId", async () => {
    const { store, fetchMock } = setupChrome({ deletion_pending_v1: { token: "tok-legacy" } });
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));

    expect(await finishPendingDeletion()).toBe(true);
    expect(clearHistory).toHaveBeenCalled();
    expect(clearHistoryForUser).not.toHaveBeenCalled();
    expect(store.deletion_pending_v1).toBeUndefined();
  });

  it("finishPendingDeletion is a no-op when nothing is pending", async () => {
    const { fetchMock } = setupChrome({});
    expect(await finishPendingDeletion()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
