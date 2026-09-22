// SPDX-License-Identifier: GPL-3.0-or-later
//
// The per-provider account key. An Ed25519 key the extension generates at the
// first sign-in through a provider and proves to the API through the OIDC nonce:
// the nonce the provider signs into its token commits to this key, so only the
// browser that holds it can later authorise an epoch-key issue (epoch-keys.ts)
// for the account. It lives in the same IndexedDB as the epoch keys, keyed by
// provider id, and stays across sign-outs: only deleting the account removes it.
// Nothing carries it across a reinstall, so a reinstalled extension generates a new
// one at its next sign-in.

import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";
import type { OidcProvider } from "../shared/oidc-providers";
import { runTransaction } from "./idb-open";
import { ACCOUNT_KEYS_STORE, keysDb } from "./keys-db";
import { bytesToHex, issueMessage, nonceMessage } from "./vote-signing";

interface AccountKeyRow {
  provider: OidcProvider;
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  createdAt: number;
}

/** What leaves this module: the secret stays inside its rows. */
export interface AccountKey {
  provider: OidcProvider;
  publicKey: Uint8Array;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
}

async function readRow(provider: OidcProvider): Promise<AccountKeyRow | undefined> {
  const db = await keysDb.open();
  return runTransaction(db, ACCOUNT_KEYS_STORE, "readonly", "account key read aborted", (store) => {
    const req = store.get(provider);
    return () => req.result as AccountKeyRow | undefined;
  });
}

/** The provider's account key, generated on first use. Two concurrent asks
 *  settle inside one transaction, so the second keeps the first one's key. */
export async function ensureAccountKey(provider: OidcProvider): Promise<AccountKey> {
  const privateKey = utils.randomSecretKey();
  const fresh: AccountKeyRow = { provider, privateKey, publicKey: await getPublicKeyAsync(privateKey), createdAt: Date.now() };
  const db = await keysDb.open();
  const row = await runTransaction(db, ACCOUNT_KEYS_STORE, "readwrite", "account key write aborted", (store) => {
    let kept = fresh;
    const req = store.get(provider);
    req.onsuccess = () => {
      const existing = req.result as AccountKeyRow | undefined;
      if (existing) kept = existing;
      else store.put(fresh);
    };
    return () => kept;
  });
  return { provider: row.provider, publicKey: row.publicKey };
}

/** The `nonce` query the sign-in start URL carries: lowercase hex SHA-256 over
 *  the nonce message (vote-signing.ts). */
export async function signInNonce(accountPubkey: Uint8Array, nonceSalt: Uint8Array): Promise<string> {
  return bytesToHex(await sha256(nonceMessage(accountPubkey, nonceSalt)));
}

/** The account's authorisation of one epoch-key issue: an Ed25519 signature over
 *  the issue message (vote-signing.ts) under the provider's account key. */
export async function signIssue(provider: OidcProvider, epoch: number, blindedHash: Uint8Array): Promise<{ accountPubkey: Uint8Array; accountSig: Uint8Array }> {
  const row = await readRow(provider);
  if (!row) throw new Error(`no account key for provider ${provider}`);
  return { accountPubkey: row.publicKey, accountSig: await signAsync(issueMessage(epoch, blindedHash), row.privateKey) };
}

/** Account deletion: the key goes with the account it was registered under. */
export async function clearAccountKey(provider: OidcProvider): Promise<void> {
  const db = await keysDb.open();
  await runTransaction(db, ACCOUNT_KEYS_STORE, "readwrite", "account key delete aborted", (store) => {
    store.delete(provider);
    return () => undefined;
  });
}

/** For a deletion that no longer knows its provider (a resume marker written
 *  before the field existed): every provider's key goes. */
export async function clearAccountKeys(): Promise<void> {
  const db = await keysDb.open();
  await runTransaction(db, ACCOUNT_KEYS_STORE, "readwrite", "account key wipe aborted", (store) => {
    store.clear();
    return () => undefined;
  });
}
