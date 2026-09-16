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

// Same for the vote queue: votequeue.browser.test.ts owns the scoped wipe itself,
// here only the deletion path's call for it matters.
const clearQueuedVotes = vi.fn(async (_userId?: string) => {});
vi.mock("./votequeue", () => ({
  clearQueuedVotes: (userId?: string) => clearQueuedVotes(userId),
}));

// And the signing keys (epoch-keys.browser.test.ts): only that deletion wipes them.
const clearEpochKeysForUser = vi.fn(async (_userId: string) => {});
vi.mock("./epoch-keys", () => ({
  clearEpochKeysForUser: (userId: string) => clearEpochKeysForUser(userId),
}));

import { deleteAccount, finishPendingDeletion, getAuth, listSignInProviders, revokeSessionServerSide, signInWithProvider } from "./identity";

const REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/";
const SESSION_BODY = { userId: "u1", token: "tok-123", expiresAtSec: FROZEN_SEC + 3600, epochMs: 2_592_000_000 };

// The identity API as the fake chrome lacks it: `launch` answers what the
// browser's window came back with, or rejects the way a closed window does.
function stubIdentity(launch: (details: { url: string; interactive: boolean }) => Promise<string | undefined>): ReturnType<typeof vi.fn> {
  const launchWebAuthFlow = vi.fn(launch);
  Object.assign(globalThis.chrome, { identity: { getRedirectURL: () => REDIRECT, launchWebAuthFlow } });
  return launchWebAuthFlow;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  // Every JSON POST reads the install id from storage.local before it goes out.
  installFakeChrome({ id: "a".repeat(32), manifest: { version: "0.1.0" } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearHistory.mockClear();
  clearHistoryForUser.mockClear();
  clearQueuedVotes.mockClear();
  clearEpochKeysForUser.mockClear();
});

describe("signInWithProvider", () => {
  it("opens the API's start URL for the provider on the browser's own redirect origin", async () => {
    const launch = stubIdentity(async () => `${REDIRECT}#code=one-time`);
    stubFetchJson(200, SESSION_BODY);

    await signInWithProvider("google");

    const [details] = launch.mock.calls[0] as [{ url: string; interactive: boolean }];
    const url = new URL(details.url);
    expect(url.pathname).toBe("/auth/oidc/start");
    expect(url.searchParams.get("provider")).toBe("google");
    expect(url.searchParams.get("redirect")).toBe(REDIRECT);
    expect(details.interactive).toBe(true);
  });

  // Pins the seconds-vs-milliseconds contract: the wire field is `expiresAtSec`,
  // the stored `expiresAt` carries the same unit (rationale in identity.ts).
  it("exchanges the code and stores the session with its provider and epoch length", async () => {
    stubIdentity(async () => `${REDIRECT}#code=one-time`);
    const fetchMock = stubFetchJson(200, SESSION_BODY);

    expect(await signInWithProvider("google")).toEqual({ ok: true });

    const [url, init] = lastFetchCall(fetchMock);
    expect(url).toContain("/auth/oidc/exchange");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ code: "one-time" });
    expect(await getAuth()).toEqual({ userId: "u1", token: "tok-123", expiresAt: SESSION_BODY.expiresAtSec, provider: "google", epochMs: SESSION_BODY.epochMs });
  });

  it("sends the client identity headers with the exchange", async () => {
    stubIdentity(async () => `${REDIRECT}#code=one-time`);
    const fetchMock = stubFetchJson(200, SESSION_BODY);
    vi.stubGlobal("navigator", { language: "uk-UA" });

    await signInWithProvider("google");

    const [, init] = lastFetchCall(fetchMock);
    expect(init.headers).toMatchObject({
      "content-type": "application/json",
      "accept-language": "uk-UA",
      "x-emojery-client": "extension",
      "x-emojery-client-version": "0.1.0",
      "x-emojery-runtime-id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "x-emojery-install-id": expect.stringMatching(/^[A-Za-z0-9_-]{16,128}$/),
    });
  });

  it.each([
    ["enroll_unavailable", "enrollment_failed"],
    ["access_denied", "provider_denied"],
    ["oidc_upstream_failed", "provider_denied"],
    ["oidc_token_invalid", "provider_denied"],
    ["oidc_state_invalid", "unavailable"],
  ] as const)("classifies a #error=%s callback as %s without exchanging anything", async (error, refusal) => {
    stubIdentity(async () => `${REDIRECT}#error=${error}&retry=1`);
    const fetchMock = stubFetch(async () => new Response("", { status: 500 }));

    expect(await signInWithProvider("google")).toEqual({ ok: false, refusal });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(await getAuth()).toBeNull();
  });

  it("reads a closed identity window as cancelled, and any other launch failure as unavailable", async () => {
    stubIdentity(async () => {
      throw new Error("The user did not approve access.");
    });
    expect(await signInWithProvider("google")).toEqual({ ok: false, refusal: "cancelled" });

    stubIdentity(async () => {
      throw new Error("User cancelled or denied access.");
    });
    expect(await signInWithProvider("google")).toEqual({ ok: false, refusal: "cancelled" });

    stubIdentity(async () => undefined);
    expect(await signInWithProvider("google")).toEqual({ ok: false, refusal: "cancelled" });

    stubIdentity(async () => {
      throw new Error("Authorization page could not be loaded.");
    });
    expect(await signInWithProvider("google")).toEqual({ ok: false, refusal: "unavailable" });
  });

  it("reports unavailable where the browser has no identity API", async () => {
    expect(await signInWithProvider("google")).toEqual({ ok: false, refusal: "unavailable" });
  });

  it.each([
    [403, "client_outdated", "client_outdated"],
    [403, "unsupported_client", "unavailable"],
    [400, "code_invalid", "unavailable"],
    [500, "boom", "unavailable"],
  ] as const)("classifies a %i %s exchange as %s", async (status, error, refusal) => {
    stubIdentity(async () => `${REDIRECT}#code=one-time`);
    stubFetchJson(status, { error });
    expect(await signInWithProvider("google")).toEqual({ ok: false, refusal });
    expect(await getAuth()).toBeNull();
  });

  it("rejects a session body without the epoch length rather than storing one that cannot sign", async () => {
    stubIdentity(async () => `${REDIRECT}#code=one-time`);
    stubFetchJson(200, { userId: "u1", token: "tok-123", expiresAtSec: FROZEN_SEC + 3600 });

    expect(await signInWithProvider("google")).toEqual({ ok: false, refusal: "unavailable" });
    expect(await getAuth()).toBeNull();
  });
});

describe("listSignInProviders", () => {
  it("returns the API's ids, dropping anything that is not a provider id", async () => {
    stubFetchJson(200, { providers: ["google", "test", "Bad Id", 42, ""] });
    expect(await listSignInProviders()).toEqual(["google", "test"]);
  });

  it("rejects an unreadable list", async () => {
    stubFetchJson(503, {});
    await expect(listSignInProviders()).rejects.toThrow("providers list unavailable");
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
  provider: "google",
  epochMs: 2_592_000_000,
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

  // A session the email-code builds wrote has no provider and no epoch length,
  // so nothing in it can sign a vote: it reads as signed out and is dropped.
  it("drops a record written by an email-code build", async () => {
    const { store } = setupChrome({ auth_v1: { userId: "u1", token: "tok-123", expiresAt: FROZEN_SEC + 99_999, email: "a@b.com" } });
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
    expect(JSON.parse(init.body as string)).toEqual({ lang: "en-US" });
    expect(store.auth_v1).toBeUndefined();
    expect(clearHistoryForUser).toHaveBeenCalledWith("u1");
    expect(clearHistory).not.toHaveBeenCalled();
    // Pending votes outlive the session, so the deleted account's own are wiped here.
    expect(clearQueuedVotes).toHaveBeenCalledWith("u1");
    // The signing keys go with the account - deletion is the only path that removes them.
    expect(clearEpochKeysForUser).toHaveBeenCalledWith("u1");
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
    expect(session.deletion_pending_v1).toEqual({ token: "tok-123", userId: "u1", expiresAt: AUTH.expiresAt }); // retry later, still scoped
    expect(clearEpochKeysForUser).not.toHaveBeenCalled();
  });

  // The marker is the one place a bearer token survives clearAuth(), so it must not
  // outlive the token: past the expiry it is dropped unread instead of being retried.
  it("finishPendingDeletion drops an expired marker without sending anything", async () => {
    const { store, fetchMock } = setupChrome({
      deletion_pending_v1: { token: "tok-stale", userId: "u9", expiresAt: FROZEN_SEC - 1 },
    });

    expect(await finishPendingDeletion()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(store.deletion_pending_v1).toBeUndefined();
  });

  it("finishPendingDeletion drains a pending marker; 401 (already erased) counts as done", async () => {
    const { store, session, fetchMock } = setupChrome({ own_reactions_v2: { "facebook:2": { reaction: "🔥", userId: "u2" } } }, { deletion_pending_v1: { token: "tok-xyz", userId: "u9" } });
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));

    const ok = await finishPendingDeletion();

    expect(ok).toBe(true);
    const [, init] = lastFetchCall(fetchMock);
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer tok-xyz");
    expect(session.deletion_pending_v1).toBeUndefined();
    expect(clearHistoryForUser).toHaveBeenCalledWith("u9");
    expect(clearEpochKeysForUser).toHaveBeenCalledWith("u9");
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
    expect(clearEpochKeysForUser).not.toHaveBeenCalled();
    expect(clearQueuedVotes).toHaveBeenCalledWith(undefined);
    expect(store.deletion_pending_v1).toBeUndefined();
  });

  it("finishPendingDeletion is a no-op when nothing is pending", async () => {
    const { fetchMock } = setupChrome({});
    expect(await finishPendingDeletion()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
