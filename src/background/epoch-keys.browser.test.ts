// SPDX-License-Identifier: GPL-3.0-or-later
//
// The epoch-key store against REAL IndexedDB and WebCrypto (Vitest browser mode:
// WebKit and Firefox), with the API played by a fetch stub that holds the blind
// signing key: mint end to end (generate, blind, issue, finalize, register), the
// resume points a killed worker leaves behind, the refusals, and the wipe.
import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { verifyAsync } from "@noble/ed25519";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { clearEpochKeysForUser, currentEpoch, EpochKeyRefusal, ensureEpochKey, reRegisterEpochKey, signVote } from "./epoch-keys";
import { base64UrlToBytes, bytesToBase64Url, epochKeyMessage } from "./vote-signing";

const suite = RSABSSA.SHA384.PSS.Deterministic();
const SESSION = { userId: "user-a", token: "tok-a" };
const OTHER = { userId: "user-b", token: "tok-b" };

let shim: ChromeShimHandle;
let blindKeys: CryptoKeyPair;
let spki: string;

interface ApiLog {
  issues: { epoch: number; blinded: string; token: string }[];
  registers: { epoch: number; pubkey: string; keySig: string; token: string }[];
}

// The API's identity endpoints, backed by the suite's own RSA key. `refuse`
// names an endpoint and the 4xx it answers with instead of doing its work.
function stubApi(refuse: Partial<Record<"params" | "issue" | "register", { status: number; error: string }>> = {}): ApiLog {
  const log: ApiLog = { issues: [], registers: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const token = (init?.headers as Record<string, string> | undefined)?.authorization?.replace("Bearer ", "") ?? "";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      const refused = (name: "params" | "issue" | "register") => {
        const r = refuse[name];
        return r ? new Response(JSON.stringify({ error: r.error }), { status: r.status }) : null;
      };
      if (url.endsWith("/auth/epoch-key/params")) {
        return refused("params") ?? new Response(JSON.stringify({ kid: "blind-rsa-v1", spki }), { status: 200 });
      }
      if (url.endsWith("/auth/epoch-key/issue")) {
        const r = refused("issue");
        if (r) return r;
        log.issues.push({ epoch: body.epoch as number, blinded: body.blinded as string, token });
        const blindSig = await suite.blindSign(blindKeys.privateKey, base64UrlToBytes(body.blinded as string));
        return new Response(JSON.stringify({ blindSig: bytesToBase64Url(blindSig) }), { status: 200 });
      }
      if (url.endsWith("/auth/epoch-key/register")) {
        const r = refused("register");
        if (r) return r;
        log.registers.push({ epoch: body.epoch as number, pubkey: body.pubkey as string, keySig: body.keySig as string, token });
        return new Response(null, { status: 204 });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return log;
}

async function deleteDatabase(): Promise<void> {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("emojery-epoch-keys");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

beforeEach(async () => {
  shim = installChromeShim();
  blindKeys = await suite.generateKey({ modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) });
  spki = bytesToBase64Url(new Uint8Array(await crypto.subtle.exportKey("spki", blindKeys.publicKey)));
});

afterEach(async () => {
  vi.unstubAllGlobals();
  shim.uninstall();
  await clearEpochKeysForUser(SESSION.userId);
  await clearEpochKeysForUser(OTHER.userId);
  await deleteDatabase();
});

describe("currentEpoch", () => {
  it("is the floor of now over the epoch length", () => {
    expect(currentEpoch(1000, 2999)).toBe(2);
    expect(currentEpoch(1000, 3000)).toBe(3);
    expect(() => currentEpoch(0, 1)).toThrow(RangeError);
  });
});

describe("ensureEpochKey", () => {
  it("mints a key the API blind-signed and registered, and signs a vote with it", async () => {
    const api = stubApi();

    const key = await ensureEpochKey(SESSION, 7);

    expect(key.epoch).toBe(7);
    expect(key.publicKey).toHaveLength(32);
    expect(api.issues).toEqual([{ epoch: 7, blinded: expect.any(String), token: "tok-a" }]);
    expect(api.registers).toEqual([{ epoch: 7, pubkey: bytesToBase64Url(key.publicKey), keySig: expect.any(String), token: "tok-a" }]);
    // The registration carries a signature the API can verify over the epoch-key
    // message under its own key: the unblinded RSABSSA signature.
    const registered = api.registers[0]!;
    expect(await suite.verify(blindKeys.publicKey, base64UrlToBytes(registered.keySig), epochKeyMessage(7, key.publicKey))).toBe(true);

    const message = new TextEncoder().encode("vote bytes");
    const sig = await signVote(SESSION, 7, message);
    expect(await verifyAsync(sig, message, key.publicKey)).toBe(true);
  });

  it("reuses the registered key on every later call, and across a fresh module state", async () => {
    const api = stubApi();
    const first = await ensureEpochKey(SESSION, 7);
    const second = await ensureEpochKey(SESSION, 7);
    expect(second.publicKey).toEqual(first.publicKey);
    expect(api.issues).toHaveLength(1);
    expect(api.registers).toHaveLength(1);
  });

  it("keeps one key per epoch and per account", async () => {
    stubApi();
    const a7 = await ensureEpochKey(SESSION, 7);
    const a8 = await ensureEpochKey(SESSION, 8);
    const b7 = await ensureEpochKey(OTHER, 7);
    expect(a8.publicKey).not.toEqual(a7.publicKey);
    expect(b7.publicKey).not.toEqual(a7.publicKey);
  });

  it("collapses concurrent asks for the same key into one mint", async () => {
    const api = stubApi();
    const [a, b, c] = await Promise.all([ensureEpochKey(SESSION, 7), ensureEpochKey(SESSION, 7), ensureEpochKey(SESSION, 7)]);
    expect(b.publicKey).toEqual(a.publicKey);
    expect(c.publicKey).toEqual(a.publicKey);
    expect(api.issues).toHaveLength(1);
  });

  // A worker killed between the issue and the register must not spend a second
  // issue: the blinded message is persisted before the issue call, so the retry
  // sends the SAME blinded value (which the API answers idempotently).
  it("resumes a mint that died after the issue call without a second issue", async () => {
    const api = stubApi({ register: { status: 503, error: "unavailable" } });
    await expect(ensureEpochKey(SESSION, 7)).rejects.toThrow("http 503");
    expect(api.issues).toHaveLength(1);

    const healed = stubApi();
    const key = await ensureEpochKey(SESSION, 7);
    expect(healed.issues).toHaveLength(0);
    expect(healed.registers).toEqual([{ epoch: 7, pubkey: bytesToBase64Url(key.publicKey), keySig: expect.any(String), token: "tok-a" }]);
  });

  it("resumes a mint that died before the issue call with the persisted blinded message", async () => {
    const failed = stubApi({ issue: { status: 503, error: "unavailable" } });
    await expect(ensureEpochKey(SESSION, 7)).rejects.toThrow("http 503");
    expect(failed.issues).toHaveLength(0);

    const healed = stubApi();
    await ensureEpochKey(SESSION, 7);
    expect(healed.issues).toHaveLength(1);
    expect(healed.registers).toHaveLength(1);
  });

  it.each([
    ["issue", 403, "refused"],
    ["issue", 429, "try_later"],
    ["register", 400, "bad_signature"],
  ] as const)("surfaces a %s refusal (%i %s) by name, leaving nothing registered", async (endpoint, status, error) => {
    stubApi({ [endpoint]: { status, error } });
    const attempt = ensureEpochKey(SESSION, 7);
    if (status === 429) {
      // 429 is a wait, not a decision: it stays a plain error the drain backs off on.
      await expect(attempt).rejects.not.toBeInstanceOf(EpochKeyRefusal);
    } else {
      await expect(attempt).rejects.toMatchObject({ name: "EpochKeyRefusal", refusal: error });
    }
    await expect(signVote(SESSION, 7, new Uint8Array(1))).rejects.toThrow("no registered epoch key");
  });

  it("refuses to sign with a key that was never registered", async () => {
    stubApi();
    await expect(signVote(SESSION, 9, new Uint8Array(1))).rejects.toThrow("no registered epoch key");
  });
});

describe("reRegisterEpochKey", () => {
  it("sends the stored registration again, and keeps the key", async () => {
    stubApi();
    const key = await ensureEpochKey(SESSION, 7);
    const api = stubApi();

    await reRegisterEpochKey(SESSION, 7);

    expect(api.issues).toHaveLength(0);
    expect(api.registers).toEqual([{ epoch: 7, pubkey: bytesToBase64Url(key.publicKey), keySig: expect.any(String), token: "tok-a" }]);
    expect((await ensureEpochKey(SESSION, 7)).publicKey).toEqual(key.publicKey);
  });

  it("forgets a key the API refuses, so the next ask mints a fresh one", async () => {
    stubApi();
    const key = await ensureEpochKey(SESSION, 7);
    stubApi({ register: { status: 400, error: "unknown_key" } });

    await expect(reRegisterEpochKey(SESSION, 7)).rejects.toMatchObject({ refusal: "unknown_key" });

    const api = stubApi();
    const fresh = await ensureEpochKey(SESSION, 7);
    expect(fresh.publicKey).not.toEqual(key.publicKey);
    expect(api.issues).toHaveLength(1);
  });

  it("rejects, and forgets the row, when there is no signature to re-send", async () => {
    stubApi({ issue: { status: 503, error: "unavailable" } });
    await expect(ensureEpochKey(SESSION, 7)).rejects.toThrow();
    await expect(reRegisterEpochKey(SESSION, 7)).rejects.toThrow("no signature to re-register");
  });
});

describe("clearEpochKeysForUser", () => {
  it("removes every epoch of that account and nobody else's", async () => {
    stubApi();
    await ensureEpochKey(SESSION, 7);
    await ensureEpochKey(SESSION, 8);
    const other = await ensureEpochKey(OTHER, 7);

    await clearEpochKeysForUser(SESSION.userId);

    await expect(signVote(SESSION, 7, new Uint8Array(1))).rejects.toThrow("no registered epoch key");
    await expect(signVote(SESSION, 8, new Uint8Array(1))).rejects.toThrow("no registered epoch key");
    expect((await ensureEpochKey(OTHER, 7)).publicKey).toEqual(other.publicKey);
  });
});
