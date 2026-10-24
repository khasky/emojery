// SPDX-License-Identifier: GPL-3.0-or-later
//
// The device-key store against REAL IndexedDB and WebCrypto (Vitest browser mode): one
// non-extractable key per provider that survives a second ask, signatures that verify under
// the stored public key, replacement and deletion.
import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_KEYS_DB_NAME, dropDeviceKey, ensureDeviceKey, getDeviceKey, replaceDeviceKey, signWithDeviceKey } from "./device-keys";

// The Safari build signs nothing (no identity flow, counts only), and Playwright's WebKit has
// no Ed25519 in WebCrypto: the store is exercised where it runs, decided by the engine itself.
const ed25519 = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]).then(
  () => true,
  () => false,
);

afterEach(async () => {
  if (ed25519) for (const p of ["google", "apple", "test"]) await dropDeviceKey(p);
});

async function verifies(publicKey: Uint8Array, sig: Uint8Array, message: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, sig as BufferSource, message as BufferSource);
}

describe.skipIf(!ed25519)("device keys", () => {
  it("creates one key per provider and keeps it on every later ask, concurrent ones included", async () => {
    const [a, b] = await Promise.all([ensureDeviceKey("google"), ensureDeviceKey("google")]);
    expect(a.publicKey).toHaveLength(32);
    expect(b.publicKey).toEqual(a.publicKey);
    expect((await ensureDeviceKey("google")).publicKey).toEqual(a.publicKey);
    expect((await ensureDeviceKey("apple")).publicKey).not.toEqual(a.publicKey);
  });

  it("signs with a private key that cannot be exported", async () => {
    const key = await ensureDeviceKey("test");
    const message = new TextEncoder().encode("emojery");
    const sig = await signWithDeviceKey("test", message);
    expect(await verifies(key.publicKey, sig, message)).toBe(true);
    const stored = await new Promise<{ privateKey: CryptoKey }>((resolve, reject) => {
      const open = indexedDB.open(DEVICE_KEYS_DB_NAME);
      open.onsuccess = () => {
        const req = open.result.transaction("keys").objectStore("keys").get("test");
        req.onsuccess = () => {
          resolve(req.result);
          open.result.close();
        };
        req.onerror = () => reject(req.error);
      };
    });
    expect(stored.privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", stored.privateKey)).rejects.toThrow();
  });

  it("replaces and drops a provider's key", async () => {
    const first = await ensureDeviceKey("google");
    const second = await replaceDeviceKey("google");
    expect(second.publicKey).not.toEqual(first.publicKey);
    expect((await getDeviceKey("google"))?.publicKey).toEqual(second.publicKey);
    await dropDeviceKey("google");
    expect(await getDeviceKey("google")).toBeNull();
    await expect(signWithDeviceKey("google", new Uint8Array(1))).rejects.toThrow("no device key");
  });
});
