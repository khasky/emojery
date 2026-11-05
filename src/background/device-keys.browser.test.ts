// SPDX-License-Identifier: GPL-3.0-or-later
//
// The device-key store against REAL IndexedDB and WebCrypto (Vitest browser mode): the key a
// sign-in starts with, the key each provider account keeps across a switch to another account
// and back, signatures that verify under the stored public key, replacement and deletion.
import { afterEach, describe, expect, it } from "vitest";
import { DEVICE_KEYS_DB_NAME, deviceKeyForSignIn, dropDeviceKey, getDeviceKey, replaceDeviceKey, settleAccountKey, signWithDeviceKey } from "./device-keys";

// The Safari build signs nothing (no identity flow, counts only), and Playwright's WebKit has
// no Ed25519 in WebCrypto: the store is exercised where it runs, decided by the engine itself.
const ed25519 = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign"]).then(
  () => true,
  () => false,
);

afterEach(async () => {
  if (!ed25519) return;
  await new Promise<void>((resolve, reject) => {
    const open = indexedDB.open(DEVICE_KEYS_DB_NAME);
    open.onsuccess = () => {
      const tx = open.result.transaction("account_keys", "readwrite");
      tx.objectStore("account_keys").clear();
      tx.oncomplete = () => {
        open.result.close();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    };
  });
});

async function verifies(publicKey: Uint8Array, sig: Uint8Array, message: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", publicKey as BufferSource, { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, sig as BufferSource, message as BufferSource);
}

describe.skipIf(!ed25519)("device keys", () => {
  it("starts every sign-in with one key per provider, concurrent asks included", async () => {
    const [a, b] = await Promise.all([deviceKeyForSignIn("google"), deviceKeyForSignIn("google")]);
    expect(a.publicKey).toHaveLength(32);
    expect(b.pk).toBe(a.pk);
    expect((await deviceKeyForSignIn("google")).pk).toBe(a.pk);
    expect((await deviceKeyForSignIn("apple")).pk).not.toBe(a.pk);
  });

  it("keeps each account's key through a switch to another account and back", async () => {
    const first = await deviceKeyForSignIn("test");
    // A key no account claimed yet goes to the first account that signs in with it.
    expect(await settleAccountKey("test", "account-a", first.pk)).toBe(true);
    expect(await settleAccountKey("test", "account-a", first.pk)).toBe(true);

    // B answers a sign-in that started with A's key: B gets a key of its own, used next.
    expect(await settleAccountKey("test", "account-b", first.pk)).toBe(false);
    const forB = await deviceKeyForSignIn("test");
    expect(forB.pk).not.toBe(first.pk);
    expect(await settleAccountKey("test", "account-b", forB.pk)).toBe(true);

    // A again, on a sign-in that started with B's key: A's own key comes back.
    expect(await settleAccountKey("test", "account-a", forB.pk)).toBe(false);
    expect((await deviceKeyForSignIn("test")).pk).toBe(first.pk);
    expect(await settleAccountKey("test", "account-a", first.pk)).toBe(true);
    expect(await getDeviceKey(forB.pk)).not.toBeNull();
  });

  it("signs with a private key that cannot be exported", async () => {
    const key = await deviceKeyForSignIn("test");
    const message = new TextEncoder().encode("emojery");
    const sig = await signWithDeviceKey(key.pk, message);
    expect(await verifies(key.publicKey, sig, message)).toBe(true);
    const stored = await new Promise<{ privateKey: CryptoKey }>((resolve, reject) => {
      const open = indexedDB.open(DEVICE_KEYS_DB_NAME);
      open.onsuccess = () => {
        const req = open.result.transaction("account_keys").objectStore("account_keys").get(key.pk);
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

  it("replaces an account's key in place, and drops a key", async () => {
    const first = await deviceKeyForSignIn("google");
    await settleAccountKey("google", "account-a", first.pk);
    await replaceDeviceKey("google", first.pk);
    expect(await getDeviceKey(first.pk)).toBeNull();
    const second = await deviceKeyForSignIn("google");
    expect(second.pk).not.toBe(first.pk);
    // The replacement serves the same account.
    expect(await settleAccountKey("google", "account-a", second.pk)).toBe(true);
    await dropDeviceKey(second.pk);
    expect(await getDeviceKey(second.pk)).toBeNull();
    await expect(signWithDeviceKey(second.pk, new Uint8Array(1))).rejects.toThrow("no device key");
  });
});
