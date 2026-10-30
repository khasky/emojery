// SPDX-License-Identifier: GPL-3.0-or-later
//
// The 1.1.0 session against a fake API: the client-side sign-in a device key signs, the
// background registration repeated until the key is enrolled, the refusals, the refresh and
// the deletion. The device key is a real WebCrypto Ed25519 key held in memory here; the
// IndexedDB store itself is device-keys.browser.test.ts's.
import { fromBase64Url, refreshMessage, retireMessage, sessionMessage, toBase64Url } from "@emojery/shared/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, stubFetch } from "../test/fixtures";

const FROZEN_NOW = Date.UTC(2026, 9, 24);
const FROZEN_SEC = FROZEN_NOW / 1000;
const LOG = "log-staging.emojery.app";
const ORIGIN = `${LOG}/g0`;
const REDIRECT = "https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/";

// The device key: a real key pair per provider, in memory.
const keys = new Map<string, { pair: CryptoKeyPair; publicKey: Uint8Array }>();
async function newKey(provider: string): Promise<{ provider: string; publicKey: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  keys.set(provider, { pair, publicKey });
  return { provider, publicKey };
}
const replaceDeviceKey = vi.fn(newKey);
const dropDeviceKey = vi.fn(async (provider: string) => void keys.delete(provider));
vi.mock("./device-keys", () => ({
  ensureDeviceKey: async (provider: string) => {
    const k = keys.get(provider);
    return k ? { provider, publicKey: k.publicKey } : newKey(provider);
  },
  getDeviceKey: async (provider: string) => {
    const k = keys.get(provider);
    return k ? { provider, publicKey: k.publicKey } : null;
  },
  replaceDeviceKey: (provider: string) => replaceDeviceKey(provider),
  dropDeviceKey: (provider: string) => dropDeviceKey(provider),
  signWithDeviceKey: async (provider: string, message: Uint8Array) => {
    const k = keys.get(provider);
    if (!k) throw new Error("no key");
    return new Uint8Array(await crypto.subtle.sign("Ed25519", k.pair.privateKey, message as BufferSource));
  },
}));
const clearHistoryForUser = vi.fn(async (_userId: string) => {});
vi.mock("./history", () => ({ clearHistoryForUser: (u: string) => clearHistoryForUser(u) }));

const { deleteAccount, getAuth, listSignInProviders, readMe, refreshSession, resumeEnrollment, setOnEnrolled, signInWithProvider } = await import("./identity");

async function verify(provider: string, sig: string, message: Uint8Array): Promise<boolean> {
  const k = keys.get(provider);
  if (!k) return false;
  return crypto.subtle.verify("Ed25519", k.pair.publicKey, fromBase64Url(sig) as BufferSource, message as BufferSource);
}

function idToken(exp = FROZEN_SEC + 600): string {
  const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc({ sub: "e2e", exp })}.c2ln`;
}

const STAGING_ID = "aooajklhnjjhmmffihjjofjkhpekbpaa";

let launched: URL | null = null;
function stubIdentity(answer: (url: URL) => string, redirect = REDIRECT): void {
  Object.assign(globalThis.chrome, {
    identity: {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: vi.fn((details: { url: string }, done?: (url?: string) => void) => {
        launched = new URL(details.url);
        const result = answer(launched);
        if (done) done(result);
        return Promise.resolve(result);
      }),
    },
    alarms: { create: vi.fn(), clear: vi.fn(), onAlarm: { addListener: vi.fn() } },
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const pendingBody = { accessToken: "tok-pending", expiresAt: FROZEN_SEC + 3600, origin: ORIGIN, enrollHash: null, enroll: { state: "pending" } };
const enrolledBody = (eh = toBase64Url(new Uint8Array(32).fill(9))) => ({ accessToken: "tok-enrolled", expiresAt: FROZEN_SEC + 3600, origin: ORIGIN, enrollHash: eh, enroll: { state: "enrolled", seq: 7 } });

let chromeFake: ReturnType<typeof installFakeChrome>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], now: FROZEN_NOW });
  chromeFake = installFakeChrome({ id: "a".repeat(32), manifest: { version: "1.1.0" } });
  stubIdentity((url) => `${REDIRECT}#state=${url.searchParams.get("state")}&id_token=${idToken()}`);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  keys.clear();
  replaceDeviceKey.mockClear();
  dropDeviceKey.mockClear();
  clearHistoryForUser.mockClear();
  launched = null;
});

describe("listSignInProviders", () => {
  it("offers a build the Apple return page does not know only the providers that return to the extension", async () => {
    const { providers } = await listSignInProviders();
    expect(providers).toContain("google");
    expect(providers).toContain("test");
    expect(providers).not.toContain("apple");
  });

  it("offers Apple to a build the return page knows: the staging id, and Firefox", async () => {
    installFakeChrome({ id: STAGING_ID, manifest: { version: "1.1.0" } });
    stubIdentity(() => "");
    expect((await listSignInProviders()).providers).toContain("apple");
    installFakeChrome({ id: "{random-uuid}", manifest: { version: "1.1.0" } });
    stubIdentity(() => "", "https://819e436ab7fc25b53a44230b14659ddc78459b06.extensions.allizom.org/");
    expect((await listSignInProviders()).providers).toContain("apple");
  });
});

describe("signing in with Apple", () => {
  it("returns through the API's page with the build code in front of the state", async () => {
    installFakeChrome({ id: STAGING_ID, manifest: { version: "1.1.0" } });
    stubIdentity((url) => `${REDIRECT}#code=c1&state=${url.searchParams.get("state")}&id_token=${idToken()}`);
    stubFetch(async () => json(200, enrolledBody()));
    expect(await signInWithProvider("apple")).toEqual({ ok: true });
    const url = launched as URL;
    expect(url.origin + url.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(url.searchParams.get("redirect_uri")).toBe("https://api-staging.emojery.app/v2/auth/apple/return");
    expect(url.searchParams.get("response_type")).toBe("code id_token");
    expect(url.searchParams.get("response_mode")).toBe("fragment");
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.get("state")).toMatch(/^staging\.[0-9a-f-]{36}$/);
  });

  it("is refused to a build the return page does not know", async () => {
    expect(await signInWithProvider("apple")).toEqual({ ok: false, refusal: "unavailable" });
    expect(launched).toBeNull();
  });
});

describe("signInWithProvider", () => {
  it("opens the provider with the device key's nonce and posts a session the key signed", async () => {
    const fetchMock = stubFetch(async () => json(200, enrolledBody()));
    expect(await signInWithProvider("test")).toEqual({ ok: true });

    const url = launched as URL;
    expect(url.origin + url.pathname).toBe("https://api-staging.emojery.app/test-oidc/authorize");
    expect(url.searchParams.get("client_id")).toBe("emojery-staging-test");
    expect(url.searchParams.get("response_type")).toBe("id_token");
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    const key = keys.get("test")?.publicKey as Uint8Array;
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)) as Record<string, string>;
    const salt = fromBase64Url(body.nonceSalt as string);
    const nonceInput = new Uint8Array([...new TextEncoder().encode("emojery-nonce-v1"), ...key, ...salt]);
    const nonce = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", nonceInput)), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(url.searchParams.get("nonce")).toBe(nonce);
    expect(body.accountPubkey).toBe(toBase64Url(key));
    const tokenHash = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.idToken)));
    expect(await verify("test", body.sig as string, sessionMessage(LOG, salt, tokenHash))).toBe(true);

    expect(await getAuth()).toMatchObject({ token: "tok-enrolled", provider: "test", pk: toBase64Url(key), enrollSeq: 7, origin: ORIGIN });
  });

  it("keeps a pending registration in session storage and repeats it until the key is enrolled", async () => {
    let calls = 0;
    stubFetch(async () => json(200, ++calls < 3 ? pendingBody : enrolledBody()));
    const enrolled = vi.fn();
    setOnEnrolled(enrolled);
    expect(await signInWithProvider("test")).toEqual({ ok: true });
    expect(await getAuth()).toMatchObject({ token: "tok-pending" });
    expect((await getAuth())?.enrollHash).toBeUndefined();
    expect(chromeFake.session.enroll_pending_v2).toMatchObject({ provider: "test" });

    await resumeEnrollment();
    expect(enrolled).not.toHaveBeenCalled();
    await resumeEnrollment();
    expect(enrolled).toHaveBeenCalledTimes(1);
    expect(await getAuth()).toMatchObject({ token: "tok-enrolled", enrollSeq: 7 });
    expect(chromeFake.session.enroll_pending_v2).toBeUndefined();
  });

  it("stops repeating once the id_token is about to expire", async () => {
    stubIdentity((url) => `${REDIRECT}#state=${url.searchParams.get("state")}&id_token=${idToken(FROZEN_SEC + 40)}`);
    const fetchMock = stubFetch(async () => json(200, pendingBody));
    await signInWithProvider("test");
    vi.setSystemTime(FROZEN_NOW + 15_000);
    await resumeEnrollment();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chromeFake.session.enroll_pending_v2).toBeUndefined();
  });

  it("refuses a fragment for another state, and maps the API's refusals", async () => {
    stubIdentity(() => `${REDIRECT}#state=other&id_token=${idToken()}`);
    expect(await signInWithProvider("test")).toEqual({ ok: false, refusal: "unavailable" });
    stubIdentity((url) => `${REDIRECT}#state=${url.searchParams.get("state")}&id_token=${idToken()}`);
    for (const [status, error, refusal] of [
      [401, "bad_token", "provider_denied"],
      [403, "account_type_unsupported", "provider_denied"],
      [429, "too_many_keys", "device_limit"],
      [409, "key_failed", "enrollment_failed"],
    ] as const) {
      stubFetch(async () => json(status, { error }));
      expect(await signInWithProvider("test")).toEqual({ ok: false, refusal });
    }
    expect(await getAuth()).toBeNull();
  });

  it("takes a new device key when the old one failed or belongs to another account", async () => {
    stubFetch(async () => json(409, { error: "key_in_use" }));
    await signInWithProvider("test");
    stubFetch(async () => json(409, { error: "key_failed" }));
    await signInWithProvider("test");
    expect(replaceDeviceKey).toHaveBeenCalledTimes(2);
  });

  it("treats a closed identity window as cancelled", async () => {
    Object.assign(globalThis.chrome, { identity: { getRedirectURL: () => REDIRECT, launchWebAuthFlow: vi.fn(async () => Promise.reject(new Error("The user did not approve access."))) } });
    expect(await signInWithProvider("test")).toEqual({ ok: false, refusal: "cancelled" });
  });
});

describe("the session of a signed-in key", () => {
  async function signedIn(): Promise<void> {
    stubFetch(async () => json(200, enrolledBody()));
    await signInWithProvider("test");
  }

  it("refreshes with the device key's signature over the presented exp", async () => {
    await signedIn();
    const auth = await getAuth();
    const fetchMock = stubFetch(async () => json(200, { accessToken: "tok-2", expiresAt: FROZEN_SEC + 7200 }));
    expect(await refreshSession(auth as NonNullable<typeof auth>)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-staging.emojery.app/v2/auth/refresh");
    const { sig } = JSON.parse(String(init.body)) as { sig: string };
    expect(await verify("test", sig, refreshMessage(LOG, FROZEN_SEC + 3600))).toBe(true);
    expect(await getAuth()).toMatchObject({ token: "tok-2", expiresAt: FROZEN_SEC + 7200, enrollSeq: 7 });
  });

  it("forgets the local account when /v2/auth/me says it was deleted", async () => {
    await signedIn();
    stubFetch(async () => json(401, { error: "account_deleted" }));
    expect(await readMe()).toBeNull();
    expect(await getAuth()).toBeNull();
    expect(dropDeviceKey).toHaveBeenCalledWith("test");
  });

  it("deletes the account with a RETIRE the device key signed, then wipes the local account", async () => {
    await signedIn();
    // Kept before the deletion drops it from the store.
    const publicKey = keys.get("test")?.pair.publicKey as CryptoKey;
    const fetchMock = stubFetch(async () => new Response(null, { status: 202 }));
    expect(await deleteAccount()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-staging.emojery.app/v2/auth/delete");
    const { sig } = JSON.parse(String(init.body)) as { sig: string };
    const signed = retireMessage(LOG, new Uint8Array(32).fill(9));
    expect(await crypto.subtle.verify("Ed25519", publicKey, fromBase64Url(sig) as BufferSource, signed as BufferSource)).toBe(true);
    expect(await crypto.subtle.verify("Ed25519", publicKey, fromBase64Url(sig) as BufferSource, retireMessage(LOG, new Uint8Array(32).fill(8)) as BufferSource)).toBe(false);
    expect(dropDeviceKey).toHaveBeenCalledWith("test");
    expect(clearHistoryForUser).toHaveBeenCalled();
    expect(await getAuth()).toBeNull();
    expect(chromeFake.local.deletion_pending_v1).toBeUndefined();
  });

  it("reads a 1.0.0 session record as signed out", async () => {
    chromeFake.local.auth_v1 = { userId: "u1", token: "t", expiresAt: FROZEN_SEC + 60, provider: "google", epochMs: 1 };
    expect(await getAuth()).toBeNull();
    expect(chromeFake.local.auth_v1).toBeUndefined();
  });
});
