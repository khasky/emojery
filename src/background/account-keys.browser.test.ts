// SPDX-License-Identifier: GPL-3.0-or-later
//
// The account-key store against REAL IndexedDB and WebCrypto (Vitest browser
// mode): one key per provider that survives a second ask, the issue signature
// and the sign-in nonce over the pinned wire bytes, and the two wipes.
import { verifyAsync } from "@noble/ed25519";
import { afterEach, describe, expect, it } from "vitest";
import { clearAccountKey, clearAccountKeys, ensureAccountKey, sha256, signInNonce, signIssue } from "./account-keys";
import { bytesToHex, issueMessage, nonceMessage } from "./vote-signing";

const BLINDED_HASH = new Uint8Array(32).fill(3);

afterEach(async () => {
  await clearAccountKeys();
});

describe("ensureAccountKey", () => {
  it("creates one key per provider and keeps it on every later ask", async () => {
    const google = await ensureAccountKey("google");
    expect(google.publicKey).toHaveLength(32);
    expect((await ensureAccountKey("google")).publicKey).toEqual(google.publicKey);
    expect((await ensureAccountKey("apple")).publicKey).not.toEqual(google.publicKey);
  });

  it("settles two concurrent first asks on one key", async () => {
    const [a, b] = await Promise.all([ensureAccountKey("google"), ensureAccountKey("google")]);
    expect(b.publicKey).toEqual(a.publicKey);
    expect((await ensureAccountKey("google")).publicKey).toEqual(a.publicKey);
  });
});

describe("signIssue", () => {
  it("signs the issue message under the provider's key, and hands that key back", async () => {
    const key = await ensureAccountKey("google");
    const { accountPubkey, accountSig } = await signIssue("google", 42, BLINDED_HASH);
    expect(accountPubkey).toEqual(key.publicKey);
    expect(await verifyAsync(accountSig, issueMessage(42, BLINDED_HASH), key.publicKey)).toBe(true);
    // A different epoch is a different message.
    expect(await verifyAsync(accountSig, issueMessage(43, BLINDED_HASH), key.publicKey)).toBe(false);
  });

  it("refuses without a key for the provider", async () => {
    await expect(signIssue("google", 42, BLINDED_HASH)).rejects.toThrow("no account key for provider google");
  });
});

describe("signInNonce", () => {
  it("is the lowercase hex SHA-256 of the nonce message", async () => {
    const pubkey = new Uint8Array(32).fill(1);
    const salt = new Uint8Array(32).fill(2);
    const nonce = await signInNonce(pubkey, salt);
    expect(nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(nonce).toBe(bytesToHex(await sha256(nonceMessage(pubkey, salt))));
    expect(await signInNonce(pubkey, new Uint8Array(32).fill(9))).not.toBe(nonce);
  });
});

describe("wipes", () => {
  it("clearAccountKey drops that provider's key and nobody else's", async () => {
    const google = await ensureAccountKey("google");
    const apple = await ensureAccountKey("apple");
    await clearAccountKey("google");
    expect((await ensureAccountKey("google")).publicKey).not.toEqual(google.publicKey);
    expect((await ensureAccountKey("apple")).publicKey).toEqual(apple.publicKey);
  });

  it("clearAccountKeys drops every provider's key", async () => {
    await ensureAccountKey("google");
    await ensureAccountKey("apple");
    await clearAccountKeys();
    await expect(signIssue("google", 1, BLINDED_HASH)).rejects.toThrow("no account key");
    await expect(signIssue("apple", 1, BLINDED_HASH)).rejects.toThrow("no account key");
  });
});
