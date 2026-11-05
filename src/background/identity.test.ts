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

// The device keys: real key pairs in memory, by public key; a sign-in starts with the newest.
// Which key serves which account is device-keys.browser.test.ts's; here the settle answer is
// set per test.
const keys = new Map<string, { provider: string; pair: CryptoKeyPair; publicKey: Uint8Array }>();
async function newKey(provider: string): Promise<{ provider: string; pk: string; publicKey: Uint8Array }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const publicKey = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const pk = toBase64Url(publicKey);
  keys.set(pk, { provider, pair, publicKey });
  return { provider, pk, publicKey };
}
const newest = (provider: string) => [...keys.entries()].reverse().find(([, k]) => k.provider === provider);
const replaceDeviceKey = vi.fn(async (provider: string, pk: string) => {
  keys.delete(pk);
  await newKey(provider);
});
const dropDeviceKey = vi.fn(async (pk: string) => void keys.delete(pk));
const settleAccountKey = vi.fn(async (_provider: string, _account: string, _pk: string) => true);
vi.mock("./device-keys", () => ({
  deviceKeyForSignIn: async (provider: string) => {
    const found = newest(provider);
    return found ? { provider, pk: found[0], publicKey: found[1].publicKey } : newKey(provider);
  },
  settleAccountKey: (provider: string, account: string, pk: string) => settleAccountKey(provider, account, pk),
  getDeviceKey: async (pk: string) => {
    const k = keys.get(pk);
    return k ? { provider: k.provider, pk, publicKey: k.publicKey } : null;
  },
  replaceDeviceKey: (provider: string, pk: string) => replaceDeviceKey(provider, pk),
  dropDeviceKey: (pk: string) => dropDeviceKey(pk),
  signWithDeviceKey: async (pk: string, message: Uint8Array) => {
    const k = keys.get(pk);
    if (!k) throw new Error("no key");
    return new Uint8Array(await crypto.subtle.sign("Ed25519", k.pair.privateKey, message as BufferSource));
  },
}));
const clearHistoryForUser = vi.fn(async (_userId: string) => {});
vi.mock("./history", () => ({ clearHistoryForUser: (u: string) => clearHistoryForUser(u) }));

const { deleteAccount, getAuth, listSignInProviders, readMe, refreshSession, resumeEnrollment, setOnEnrolled, signInWithProvider } = await import("./identity");

async function verify(provider: string, sig: string, message: Uint8Array): Promise<boolean> {
  const k = newest(provider)?.[1];
  if (!k) return false;
  return crypto.subtle.verify("Ed25519", k.pair.publicKey, fromBase64Url(sig) as BufferSource, message as BufferSource);
}

function idToken(lifetimeSec = 600, iat = FROZEN_SEC): string {
  const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
  return `${enc({ alg: "RS256" })}.${enc({ sub: "e2e", iat, exp: iat + lifetimeSec })}.c2ln`;
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
  settleAccountKey.mockReset();
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
    const key = newest("test")?.[1].publicKey as Uint8Array;
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
    stubIdentity((url) => `${REDIRECT}#state=${url.searchParams.get("state")}&id_token=${idToken(40)}`);
    const fetchMock = stubFetch(async () => json(200, pendingBody));
    await signInWithProvider("test");
    vi.setSystemTime(FROZEN_NOW + 15_000);
    await resumeEnrollment();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(chromeFake.session.enroll_pending_v2).toBeUndefined();
  });

  it("counts the id_token's lifetime from its arrival, so a device clock an hour fast still repeats", async () => {
    stubIdentity((url) => `${REDIRECT}#state=${url.searchParams.get("state")}&id_token=${idToken(300, FROZEN_SEC - 3600)}`);
    const fetchMock = stubFetch(async () => json(200, pendingBody));
    await signInWithProvider("test");
    vi.setSystemTime(FROZEN_NOW + 15_000);
    await resumeEnrollment();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chromeFake.session.enroll_pending_v2).toMatchObject({ provider: "test" });
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

  it("settles the key against the account the id_token names, by a hash of it", async () => {
    stubFetch(async () => json(200, enrolledBody()));
    await signInWithProvider("test");
    const [provider, account, pk] = settleAccountKey.mock.calls[0] as [string, string, string];
    expect(provider).toBe("test");
    expect(account).toMatch(/^[0-9a-f]{64}$/);
    expect(pk).toBe((await getAuth())?.pk);
  });

  it("signs in again, without the chooser, when the provider answered for another key's account", async () => {
    const launches: URL[] = [];
    stubIdentity((url) => {
      launches.push(url);
      return `${REDIRECT}#state=${url.searchParams.get("state")}&id_token=${idToken()}`;
    });
    const fetchMock = stubFetch(async () => json(200, enrolledBody()));
    settleAccountKey.mockResolvedValueOnce(false);
    expect(await signInWithProvider("test", true)).toEqual({ ok: true });
    expect(launches).toHaveLength(2);
    expect(launches[0]?.searchParams.get("prompt")).toBe("select_account");
    expect(launches[1]?.searchParams.has("prompt")).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after one repeat when the provider again answers for another key's account", async () => {
    const fetchMock = stubFetch(async () => json(200, enrolledBody()));
    settleAccountKey.mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    expect(await signInWithProvider("test")).toEqual({ ok: false, refusal: "unavailable" });
    expect(settleAccountKey).toHaveBeenCalledTimes(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an id_token that names no subject", async () => {
    const enc = (o: unknown) => toBase64Url(new TextEncoder().encode(JSON.stringify(o)));
    const noSub = `${enc({ alg: "RS256" })}.${enc({ iat: FROZEN_SEC, exp: FROZEN_SEC + 600 })}.c2ln`;
    stubIdentity((url) => `${REDIRECT}#state=${url.searchParams.get("state")}&id_token=${noSub}`);
    const fetchMock = stubFetch(async () => json(200, enrolledBody()));
    expect(await signInWithProvider("test")).toEqual({ ok: false, refusal: "provider_denied" });
    expect(fetchMock).not.toHaveBeenCalled();
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
    const pk = (await getAuth())?.pk;
    stubFetch(async () => json(401, { error: "account_deleted" }));
    expect(await readMe()).toBeNull();
    expect(await getAuth()).toBeNull();
    expect(dropDeviceKey).toHaveBeenCalledWith(pk);
  });

  it("deletes the account with a RETIRE the device key signed, then wipes the local account", async () => {
    await signedIn();
    // Kept before the deletion drops it from the store.
    const publicKey = newest("test")?.[1].pair.publicKey as CryptoKey;
    const pk = (await getAuth())?.pk;
    const fetchMock = stubFetch(async () => new Response(null, { status: 202 }));
    expect(await deleteAccount()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-staging.emojery.app/v2/auth/delete");
    const { sig } = JSON.parse(String(init.body)) as { sig: string };
    const signed = retireMessage(LOG, new Uint8Array(32).fill(9));
    expect(await crypto.subtle.verify("Ed25519", publicKey, fromBase64Url(sig) as BufferSource, signed as BufferSource)).toBe(true);
    expect(await crypto.subtle.verify("Ed25519", publicKey, fromBase64Url(sig) as BufferSource, retireMessage(LOG, new Uint8Array(32).fill(8)) as BufferSource)).toBe(false);
    expect(dropDeviceKey).toHaveBeenCalledWith(pk);
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
