// SPDX-License-Identifier: GPL-3.0-or-later
//
// The per-epoch vote-signing keys. Every vote is signed with an Ed25519 key the
// API has blind-signed for the current epoch (RSABSSA, RFC 9474): the log then
// shows that a key was issued to some enrolled account, never which one. The key
// lives in IndexedDB rather than storage.local so its bytes never sit next to the
// session record every extension page can read, and it stays until the account
// is deleted - signing out and back in within an epoch reuses it.
//
// Minting is one chain per (account, epoch), resumed from wherever a previous run
// stopped: generate -> blind (persisted before the issue call, so a worker killed
// mid-flight re-sends the same blinded message rather than asking for a second
// signature) -> issue -> finalize -> register. One in-flight promise per key, so
// a drain that asks twice waits on the same chain.

import { RSABSSA } from "@cloudflare/blindrsa-ts";
import { getPublicKeyAsync, signAsync, utils } from "@noble/ed25519";
import type { OidcProvider } from "../shared/oidc-providers";
import { sha256, signIssue } from "./account-keys";
import { type ApiReply, apiErrorString, apiRequest, isRecord } from "./api-client";
import { logBackgroundError } from "./debug";
import { runTransaction } from "./idb-open";
import { keysDb, EPOCH_KEYS_STORE as STORE, EPOCH_KEYS_USER_INDEX as USER_INDEX } from "./keys-db";
import { base64UrlToBytes, bytesToBase64Url, epochKeyMessage } from "./vote-signing";

export interface EpochKeySession {
  userId: string;
  token: string;
  /** Names the account key (account-keys.ts) that authorises the issue. */
  provider: OidcProvider;
}

/** What the drain signs with. The secret stays inside this module's rows. */
export interface EpochKey {
  epoch: number;
  publicKey: Uint8Array;
}

interface EpochKeyRow {
  /** `${userId}:${epoch}` - one key per account per epoch. */
  id: string;
  userId: string;
  epoch: number;
  secretKey: Uint8Array;
  publicKey: Uint8Array;
  /** Set once blinded and before the issue call; consumed by finalize. */
  blinded?: Uint8Array;
  inv?: Uint8Array;
  /** The API's unblinded signature over the key; set once finalize verified it. */
  keySig?: Uint8Array;
  registeredAt?: number;
}

// A refusal the mint chain cannot retry into success within this epoch. The vote
// it was minting for backs off like any other failure, and the alarm retries later.
export class EpochKeyRefusal extends Error {
  constructor(readonly refusal: string) {
    super(`epoch key refused: ${refusal}`);
    this.name = "EpochKeyRefusal";
  }
}

function rowId(userId: string, epoch: number): string {
  return `${userId}:${epoch}`;
}

export function currentEpoch(epochMs: number, now: number = Date.now()): number {
  if (!Number.isFinite(epochMs) || epochMs <= 0) throw new RangeError(`currentEpoch: epochMs ${epochMs} is not a positive length`);
  return Math.floor(now / epochMs);
}

async function readRow(id: string): Promise<EpochKeyRow | undefined> {
  const db = await keysDb.open();
  return runTransaction(db, STORE, "readonly", "epoch key read aborted", (store) => {
    const req = store.get(id);
    return () => req.result as EpochKeyRow | undefined;
  });
}

async function writeRow(row: EpochKeyRow): Promise<void> {
  const db = await keysDb.open();
  await runTransaction(db, STORE, "readwrite", "epoch key write aborted", (store) => {
    store.put(row);
    return () => undefined;
  });
}

async function deleteRow(id: string): Promise<void> {
  const db = await keysDb.open();
  await runTransaction(db, STORE, "readwrite", "epoch key delete aborted", (store) => {
    store.delete(id);
    return () => undefined;
  });
}

/** Account deletion: the only path that removes a key. */
export async function clearEpochKeysForUser(userId: string): Promise<void> {
  const db = await keysDb.open();
  await runTransaction(db, STORE, "readwrite", "epoch key wipe aborted", (store) => {
    const cursorReq = store.index(USER_INDEX).openKeyCursor(IDBKeyRange.only(userId));
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (!cursor) return;
      store.delete(cursor.primaryKey);
      cursor.continue();
    };
    return () => undefined;
  });
}

const blindSuite = RSABSSA.SHA384.PSS.Deterministic();

function throwRefusal(reply: ApiReply): never {
  const error = apiErrorString(reply.body);
  // 4xx: the API has decided, and the same request cannot be retried into a
  // signature. Anything else (5xx, a body the client cannot read) is transient.
  if (reply.status >= 400 && reply.status < 500 && reply.status !== 429) throw new EpochKeyRefusal(error ?? `http ${reply.status}`);
  throw new Error(`epoch key request failed: http ${reply.status}${error ? ` ${error}` : ""}`);
}

async function fetchBlindParams(): Promise<{ kid: string; publicKey: CryptoKey }> {
  const reply = await apiRequest("/auth/epoch-key/params", { method: "GET", cache: "no-store" });
  if (!reply.ok) throwRefusal(reply);
  if (!isRecord(reply.body) || typeof reply.body.kid !== "string" || typeof reply.body.spki !== "string") throw new Error("malformed epoch-key params body");
  const publicKey = await crypto.subtle.importKey("spki", base64UrlToBytes(reply.body.spki), { name: "RSA-PSS", hash: "SHA-384" }, true, ["verify"]);
  return { kid: reply.body.kid, publicKey };
}

async function mint(session: EpochKeySession, epoch: number): Promise<EpochKeyRow> {
  const id = rowId(session.userId, epoch);
  let row = await readRow(id);
  if (row?.registeredAt) return row;
  // Signed but never registered: the register call is the only step left.
  if (row?.keySig) {
    await register(session, row, row.keySig);
    return row;
  }

  if (!row) {
    const secretKey = utils.randomSecretKey();
    row = { id, userId: session.userId, epoch, secretKey, publicKey: await getPublicKeyAsync(secretKey) };
    await writeRow(row);
  }

  const message = epochKeyMessage(epoch, row.publicKey);
  const params = await fetchBlindParams();
  let blinded = row.blinded && row.inv ? { blindedMsg: row.blinded, inv: row.inv } : undefined;
  if (!blinded) {
    blinded = await blindSuite.blind(params.publicKey, message);
    row = { ...row, blinded: blinded.blindedMsg, inv: blinded.inv };
    await writeRow(row);
  }

  // The account key vouches for the issue: the API checks the signature against
  // the key it saw at sign-in, so a session token alone cannot mint a key.
  const authorised = await signIssue(session.provider, epoch, await sha256(blinded.blindedMsg));
  const issued = await apiRequest("/auth/epoch-key/issue", {
    method: "POST",
    token: session.token,
    body: { epoch, blinded: bytesToBase64Url(blinded.blindedMsg), accountPubkey: bytesToBase64Url(authorised.accountPubkey), accountSig: bytesToBase64Url(authorised.accountSig) },
  });
  if (!issued.ok) throwRefusal(issued);
  if (!isRecord(issued.body) || typeof issued.body.blindSig !== "string") throw new Error("malformed epoch-key issue body");

  // finalize verifies the unblinded signature against the key it was blinded
  // for, so a mismatched or rotated API key fails here rather than at register.
  const keySig = await blindSuite.finalize(params.publicKey, message, base64UrlToBytes(issued.body.blindSig), blinded.inv);
  await writeRow({ ...row, keySig });

  await register(session, row, keySig);
  return row;
}

async function register(session: EpochKeySession, row: EpochKeyRow, keySig: Uint8Array): Promise<void> {
  const reply = await apiRequest("/auth/epoch-key/register", { method: "POST", token: session.token, body: { epoch: row.epoch, pubkey: bytesToBase64Url(row.publicKey), keySig: bytesToBase64Url(keySig) } });
  if (!reply.ok) throwRefusal(reply);
  await writeRow({ ...row, keySig, registeredAt: Date.now() });
}

const inFlight = new Map<string, Promise<EpochKeyRow>>();

function withSingleFlight(id: string, run: () => Promise<EpochKeyRow>): Promise<EpochKeyRow> {
  const pending = inFlight.get(id);
  if (pending) return pending;
  const chain = run().finally(() => inFlight.delete(id));
  inFlight.set(id, chain);
  return chain;
}

/** The registered key for this account and epoch, minting it on first use. */
export async function ensureEpochKey(session: EpochKeySession, epoch: number): Promise<EpochKey> {
  const row = await withSingleFlight(rowId(session.userId, epoch), () => mint(session, epoch));
  return { epoch: row.epoch, publicKey: row.publicKey };
}

/** The API answered `unknown_key`: send the registration again from the
 *  stored signature. A key it still refuses is forgotten, so the next
 *  ensureEpochKey mints a fresh one. */
export async function reRegisterEpochKey(session: EpochKeySession, epoch: number): Promise<void> {
  const id = rowId(session.userId, epoch);
  await withSingleFlight(id, async () => {
    const row = await readRow(id);
    if (!row?.keySig) {
      await deleteRow(id);
      throw new Error("epoch key has no signature to re-register");
    }
    try {
      await register(session, row, row.keySig);
    } catch (error) {
      if (error instanceof EpochKeyRefusal) {
        await deleteRow(id);
        logBackgroundError("reRegisterEpochKey.forget", error);
      }
      throw error;
    }
    return row;
  });
}

export async function signVote(session: EpochKeySession, epoch: number, message: Uint8Array): Promise<Uint8Array> {
  const row = await readRow(rowId(session.userId, epoch));
  if (!row?.registeredAt) throw new Error("no registered epoch key to sign with");
  return signAsync(message, row.secretKey);
}
