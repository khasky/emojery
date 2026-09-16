// SPDX-License-Identifier: GPL-3.0-or-later
//
// The bytes a vote and an epoch key are signed over, framed exactly as the API
// serializes them into its transparency log. A wire contract shared with the
// backend and the public verifier: `__data__/vote-signing-vectors.json` pins the
// same inputs to the same bytes on every side, so a change here is a coordinated
// release, never a local edit.
//
// Framing: `lp(s) = u32be(len) || utf8(s)`; an absent reaction is the NULL marker
// `u32be(0xFFFFFFFF)`, which no length-prefixed string can produce (an empty
// string is `u32be(0)`); `u64be` for the epoch number.

const encoder = new TextEncoder();

const VOTE_DOMAIN = "emojery-vote-v1";
const EPOCH_KEY_DOMAIN = "emojery-epoch-key-v1";
const NULL_MARKER = new Uint8Array([0xff, 0xff, 0xff, 0xff]);

function u32be(value: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value, false);
  return out;
}

function u64be(value: number): Uint8Array<ArrayBuffer> {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`u64be: ${value} is not a non-negative safe integer`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

function lengthPrefixed(text: string): Uint8Array<ArrayBuffer> {
  const bytes = encoder.encode(text);
  return concat(u32be(bytes.length), bytes);
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export interface VoteSigningInput {
  site: string;
  targetId: string;
  reaction: string | null;
  nonce: string;
}

/** `"emojery-vote-v1" || lp(site) || lp(target_id) || lp(reaction | NULL) || lp(nonce)`. */
export function voteSignatureMessage(input: VoteSigningInput): Uint8Array<ArrayBuffer> {
  return concat(encoder.encode(VOTE_DOMAIN), lengthPrefixed(input.site), lengthPrefixed(input.targetId), input.reaction === null ? NULL_MARKER : lengthPrefixed(input.reaction), lengthPrefixed(input.nonce));
}

/** `"emojery-epoch-key-v1" || u64be(epoch) || pubkey32` - what the API blind-signs. */
export function epochKeyMessage(epoch: number, pubkey: Uint8Array): Uint8Array<ArrayBuffer> {
  if (pubkey.length !== 32) throw new RangeError(`epochKeyMessage: a public key is 32 bytes, got ${pubkey.length}`);
  return concat(encoder.encode(EPOCH_KEY_DOMAIN), u64be(epoch), pubkey);
}

// The wire encoding of every byte string the identity endpoints carry.
export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Tolerant of the padded standard alphabet too: the SPKI the params endpoint
// serves is whatever a key tool emitted, and either alphabet decodes to the same key.
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || /[^0-9a-f]/i.test(hex)) throw new RangeError("hexToBytes: not a hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
