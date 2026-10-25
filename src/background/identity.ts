// SPDX-License-Identifier: GPL-3.0-or-later
//
// The session of a device key (design L): client-side OpenID, the device key's signature, and
// the background registration of a new key.
//
// Sign-in: the extension opens the provider's authorize page itself with
// nonce = hex(SHA-256("emojery-nonce-v1" || device pubkey || nonce salt)), takes the id_token
// from the fragment, signs the session message with the device key and posts it to
// /v2/auth/session. A new key answers "pending" at once: its proof runs on the server while
// this module repeats the same request every 15 s, keeping the id_token and the salt in
// storage.session only, until the key is enrolled or the token is about to expire.

import { offeredIn } from "@emojery/shared/api";
import { fromBase64Url, refreshMessage, retireMessage, sessionMessage, toBase64Url } from "@emojery/shared/core";
import { forgetAccount, noteAccountSeen } from "../shared/account-names";
import { AUTH_KEY, isAuthSessionLive } from "../shared/auth-session";
import { readClientOutdated } from "../shared/client-outdated";
import { INITIAL_ORIGIN, LOG_NAME, SIGN_IN_PROVIDERS } from "../shared/deployment";
import type { SignInRefusal } from "../shared/messages";
import { isProviderId, type OidcProvider } from "../shared/oidc-providers";
import { randomId } from "../shared/random-id";
import { activateAccountSettings, clearAutoNativesForUser, clearOwnReactionsForUser, SIGNED_OUT_ACCOUNT } from "../shared/storage";
import { clearAlarm, createAlarm, identityRedirectUrl, launchWebAuthFlow, storageLocalGet, storageLocalRemove, storageLocalSet, storageSessionGet, storageSessionRemove, storageSessionSet } from "../shared/webext";
import { apiErrorString, apiRequest, isRecord } from "./api-client";
import { logBackgroundError } from "./debug";
import { dropDeviceKey, ensureDeviceKey, getDeviceKey, replaceDeviceKey, signWithDeviceKey } from "./device-keys";
import { clearHistoryForUser } from "./history";

export interface AuthState {
  /** The local account: provider and device key. Device-local stores (history, settings,
   *  own reactions) are scoped by it; the server knows no such number. */
  userId: string;
  token: string;
  /** Seconds-epoch expiry of the token. */
  expiresAt: number;
  provider: OidcProvider;
  /** The device key, base64url. */
  pk: string;
  /** The key's ENROLL hash and seq once it is enrolled; votes are signed with the hash. */
  enrollHash?: string;
  enrollSeq?: number;
  /** The log's current origin, `<log name>/g<k>`, which every vote signs. */
  origin: string;
}

const localAccountId = (provider: string, pk: string): string => `${provider}:${pk}`;

function isStoredAuthState(value: unknown): value is AuthState {
  if (!isRecord(value)) return false;
  const r = value;
  const enrolledOk = (r.enrollHash === undefined && r.enrollSeq === undefined) || (typeof r.enrollHash === "string" && typeof r.enrollSeq === "number");
  return typeof r.token === "string" && r.token.length > 0 && typeof r.userId === "string" && r.userId.length > 0 && typeof r.expiresAt === "number" && Number.isFinite(r.expiresAt) && isProviderId(r.provider) && typeof r.pk === "string" && typeof r.origin === "string" && enrolledOk;
}

export async function getAuth(): Promise<AuthState | null> {
  const auth = (await storageLocalGet([AUTH_KEY]))[AUTH_KEY];
  if (!isStoredAuthState(auth)) {
    // A record of the 1.0.0 shape (userId + epochMs) or anything malformed reads as signed out.
    if (auth !== undefined) await storageLocalRemove([AUTH_KEY]);
    return null;
  }
  return auth;
}

/** The session when its token is still valid; an expired one is refreshed first. */
export async function getLiveAuth(): Promise<AuthState | null> {
  const auth = await getAuth();
  if (!auth) return null;
  if (isAuthSessionLive(auth.expiresAt)) return auth;
  return (await refreshSession(auth)) ? getAuth() : null;
}

async function setAuth(auth: AuthState): Promise<void> {
  await storageLocalSet({ [AUTH_KEY]: auth });
  await activateAccountSettings(auth.userId).catch((error: unknown) => logBackgroundError("setAuth.activateAccountSettings", error));
}

/** A new origin, already checked against the log's signed rewind record (origin-switch.ts). */
export async function setAuthOrigin(origin: string): Promise<void> {
  const auth = await getAuth();
  if (auth) await setAuth({ ...auth, origin });
}

export async function clearAuth(): Promise<void> {
  await storageLocalRemove([AUTH_KEY]);
  await activateAccountSettings(SIGNED_OUT_ACCOUNT).catch((error: unknown) => logBackgroundError("clearAuth.activateAccountSettings", error));
}

// ---- sign-in -------------------------------------------------------------------------------

export type SignInResult = { ok: true } | { ok: false; refusal: SignInRefusal };

/** The providers this build offers, in the table's order; none can be asked for a chooser
 *  the table does not name. Apple needs its return page, served by the API; until a build
 *  can use it, a provider with a web return address is not offered. */
export async function listSignInProviders(): Promise<{ providers: OidcProvider[]; chooser: OidcProvider[] }> {
  const rows = offeredIn(SIGN_IN_PROVIDERS).filter((p) => !p.redirectUri);
  const providers = rows.map((p) => p.id);
  return { providers, chooser: providers.filter((id) => id === "google" || id === "microsoft") };
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

async function signInNonce(pubkey: Uint8Array, nonceSalt: Uint8Array): Promise<string> {
  const msg = new Uint8Array(16 + 32 + 32);
  msg.set(utf8("emojery-nonce-v1"), 0);
  msg.set(pubkey, 16);
  msg.set(nonceSalt, 48);
  return hex(await sha256(msg));
}

// The identity window rejects with a message rather than a code: a closed window is the
// user's choice, anything else is the flow failing to run.
function launchRefusal(error: unknown): SignInRefusal {
  const message = error instanceof Error ? error.message : String(error);
  return /approve|cancel|denied|closed/i.test(message) ? "cancelled" : "unavailable";
}

// What a refused /v2/auth/session becomes on screen, keyed by `status error`.
const SESSION_REFUSALS: Record<string, SignInRefusal> = {
  "401 bad_token": "provider_denied",
  "403 token_unsupported": "provider_denied",
  "403 account_type_unsupported": "provider_denied",
  "403 account_restricted": "provider_denied",
  "403 provider_paused": "unavailable",
  "429 too_many_keys": "device_limit",
  "409 key_failed": "enrollment_failed",
  "410 client_outdated": "client_outdated",
};

const signInFlows = new Map<string, Promise<SignInResult>>();

export function signInWithProvider(provider: OidcProvider, chooser = false): Promise<SignInResult> {
  const key = `${provider}|${chooser}`;
  const running = signInFlows.get(key);
  if (running) return running;
  const flow = runSignIn(provider, chooser).finally(() => signInFlows.delete(key));
  signInFlows.set(key, flow);
  return flow;
}

/** The pending registration: the request repeated until the key is enrolled. Session storage
 *  only - never written to disk - and dropped once the key is enrolled or failed. */
const ENROLL_PENDING_KEY = "enroll_pending_v2";
export const ENROLL_RETRY_ALARM = "enroll-retry";
const ENROLL_RETRY_MS = 15_000;

interface EnrollPending {
  provider: string;
  idToken: string;
  nonceSalt: string;
  sig: string;
  pk: string;
  /** The id_token's exp, seconds: the retries stop 30 s before it. */
  tokenExp: number;
}

function idTokenExp(idToken: string): number {
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(idToken.split(".")[1] ?? ""))) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp : 0;
  } catch {
    return 0;
  }
}

async function runSignIn(provider: OidcProvider, chooser: boolean): Promise<SignInResult> {
  // A build the API retired cannot sign in; no provider window is opened for it.
  if (await readClientOutdated()) return { ok: false, refusal: "client_outdated" };
  const row = offeredIn(SIGN_IN_PROVIDERS).find((p) => p.id === provider && !p.redirectUri);
  const redirect = identityRedirectUrl();
  if (!row || !redirect) return { ok: false, refusal: "unavailable" };
  const key = await ensureDeviceKey(provider);
  const nonceSalt = crypto.getRandomValues(new Uint8Array(32));
  const state = randomId();
  const params = new URLSearchParams({ client_id: row.clientId, response_type: row.responseType, redirect_uri: redirect, nonce: await signInNonce(key.publicKey, nonceSalt), state });
  if (row.scope) params.set("scope", row.scope);
  if (row.responseMode) params.set("response_mode", row.responseMode);
  if (chooser) params.set("prompt", "select_account");

  let responseUrl: string | null;
  try {
    responseUrl = await launchWebAuthFlow(`${row.authorize}?${params}`);
  } catch (error) {
    return { ok: false, refusal: launchRefusal(error) };
  }
  if (!responseUrl) return { ok: false, refusal: "cancelled" };
  const fragment = new URLSearchParams(new URL(responseUrl).hash.replace(/^#/, ""));
  const idToken = fragment.get("id_token");
  if (fragment.get("state") !== state || !idToken) return { ok: false, refusal: fragment.get("error") ? "provider_denied" : "unavailable" };

  const sig = await signWithDeviceKey(provider, sessionMessage(LOG_NAME, nonceSalt, await sha256(utf8(idToken))));
  const pending: EnrollPending = { provider, idToken, nonceSalt: toBase64Url(nonceSalt), sig: toBase64Url(sig), pk: toBase64Url(key.publicKey), tokenExp: idTokenExp(idToken) };
  return postSession(pending, true);
}

/** One /v2/auth/session call; stores the session it answers and keeps or drops the pending
 *  registration accordingly. */
async function postSession(p: EnrollPending, firstCall: boolean): Promise<SignInResult> {
  const reply = await apiRequest("/v2/auth/session", { method: "POST", body: { provider: p.provider, idToken: p.idToken, accountPubkey: p.pk, nonceSalt: p.nonceSalt, sig: p.sig } });
  if (!reply.ok) {
    const error = apiErrorString(reply.body);
    if (reply.status === 409 && error === "key_in_use") {
      // Our key sits under another live account: a fresh key and a new sign-in.
      await replaceDeviceKey(p.provider);
    }
    if (!firstCall && (reply.status >= 500 || reply.status === 429)) {
      scheduleEnrollRetry(reply.retryAfterSeconds);
      return { ok: false, refusal: "unavailable" };
    }
    await dropPendingEnroll();
    if (error === "key_failed") await replaceDeviceKey(p.provider);
    return { ok: false, refusal: SESSION_REFUSALS[`${reply.status} ${error}`] ?? "unavailable" };
  }
  const s = reply.body;
  if (!isRecord(s) || typeof s.accessToken !== "string" || typeof s.expiresAt !== "number" || typeof s.origin !== "string" || !isRecord(s.enroll)) {
    logBackgroundError("postSession", new Error("malformed session body"));
    return { ok: false, refusal: "unavailable" };
  }
  const enrolled = s.enroll.state === "enrolled" && typeof s.enrollHash === "string" && typeof s.enroll.seq === "number";
  const auth: AuthState = {
    userId: localAccountId(p.provider, p.pk),
    token: s.accessToken,
    expiresAt: s.expiresAt,
    provider: p.provider,
    pk: p.pk,
    origin: s.origin,
    ...(enrolled ? { enrollHash: s.enrollHash as string, enrollSeq: s.enroll.seq as number } : {}),
  };
  await setAuth(auth);
  await noteAccountSeen(p.provider, auth.userId).catch((error: unknown) => logBackgroundError("postSession.noteAccountSeen", error));
  if (enrolled) {
    await dropPendingEnroll();
    onEnrolled?.();
  } else {
    await storageSessionSet({ [ENROLL_PENDING_KEY]: p });
    scheduleEnrollRetry();
  }
  return { ok: true };
}

/** Called once a key becomes enrolled: the vote queue sends what it held. */
let onEnrolled: (() => void) | null = null;
export function setOnEnrolled(fn: () => void): void {
  onEnrolled = fn;
}

let enrollTimer = 0;
function scheduleEnrollRetry(retryAfterSeconds?: number): void {
  const delay = Math.max(ENROLL_RETRY_MS, (retryAfterSeconds ?? 0) * 1000);
  if (!enrollTimer) {
    enrollTimer = self.setTimeout(() => {
      enrollTimer = 0;
      void resumeEnrollment().catch((error: unknown) => logBackgroundError("resumeEnrollment", error));
    }, delay);
  }
  // The worker may sleep before the timer fires; the alarm brings it back.
  createAlarm(ENROLL_RETRY_ALARM, { delayInMinutes: 0.5, periodInMinutes: 0.5 });
}

async function dropPendingEnroll(): Promise<void> {
  await storageSessionRemove([ENROLL_PENDING_KEY]);
  clearAlarm(ENROLL_RETRY_ALARM);
}

/** One retry of a pending registration; nothing to do when none is pending. */
export async function resumeEnrollment(): Promise<void> {
  const p = (await storageSessionGet([ENROLL_PENDING_KEY]))[ENROLL_PENDING_KEY] as EnrollPending | undefined;
  if (!p) {
    clearAlarm(ENROLL_RETRY_ALARM);
    return;
  }
  // Past the token's exp less 30 s the server would refuse it: a new sign-in, same key.
  if (p.tokenExp && Date.now() / 1000 > p.tokenExp - 30) {
    await dropPendingEnroll();
    return;
  }
  await postSession(p, false);
}

// ---- the session of a signed-in key ---------------------------------------------------------

/** GET /v2/auth/me: the key's state; a token with eh when the key became enrolled. */
export async function readMe(): Promise<{ state: "pending" | "enrolled" | "failed" } | null> {
  const auth = await getLiveAuth();
  if (!auth) return null;
  const reply = await apiRequest("/v2/auth/me", { method: "GET", token: auth.token, cache: "no-store" });
  if (reply.status === 401) {
    const error = apiErrorString(reply.body);
    if (error === "account_deleted") await clearLocalAccount(auth);
    else await clearAuth();
    return null;
  }
  if (!reply.ok || !isRecord(reply.body) || !isRecord(reply.body.enroll)) return null;
  const me = reply.body;
  const enroll = reply.body.enroll;
  const state = enroll.state === "enrolled" ? "enrolled" : enroll.state === "failed" ? "failed" : "pending";
  const next: AuthState = { ...auth, ...(typeof me.origin === "string" ? { origin: me.origin } : {}) };
  if (typeof me.accessToken === "string" && typeof me.enrollHash === "string" && typeof enroll.seq === "number") {
    next.token = me.accessToken;
    next.enrollHash = me.enrollHash;
    next.enrollSeq = enroll.seq;
  }
  await setAuth(next);
  if (state === "enrolled" && auth.enrollHash === undefined) onEnrolled?.();
  return { state };
}

/** POST /v2/auth/refresh, signed by the device key over the presented token's exp. */
export async function refreshSession(auth: AuthState): Promise<boolean> {
  try {
    const sig = await signWithDeviceKey(auth.provider, refreshMessage(LOG_NAME, auth.expiresAt));
    const reply = await apiRequest("/v2/auth/refresh", { method: "POST", token: auth.token, body: { sig: toBase64Url(sig) } });
    if (!reply.ok || !isRecord(reply.body) || typeof reply.body.accessToken !== "string" || typeof reply.body.expiresAt !== "number") {
      if (reply.status === 401) await clearAuth();
      return false;
    }
    await setAuth({ ...auth, token: reply.body.accessToken, expiresAt: reply.body.expiresAt });
    return true;
  } catch (error) {
    logBackgroundError("refreshSession", error);
    return false;
  }
}

// Ends this device's session server-side; the caller clears local state whatever the answer.
export async function revokeSessionServerSide(token: string): Promise<boolean> {
  try {
    const reply = await apiRequest("/v2/auth/logout", { method: "POST", token, keepalive: true });
    return reply.ok || reply.status === 401;
  } catch (error) {
    logBackgroundError("revokeSessionServerSide", error);
    return false;
  }
}

// ---- deletion ----------------------------------------------------------------------------

// Kept until the server answers 401 account_deleted: a deletion the server has not yet
// taken is repeated at the next start, signed in again if need be.
const DELETION_PENDING_KEY = "deletion_pending_v1";

interface DeletionPending {
  provider: string;
  pk: string;
}

export async function clearPendingDeletion(): Promise<void> {
  await storageSessionRemove([DELETION_PENDING_KEY]);
  await storageLocalRemove([DELETION_PENDING_KEY]);
}

async function clearLocalAccount(auth: Pick<AuthState, "userId" | "provider">): Promise<void> {
  await dropDeviceKey(auth.provider);
  await clearHistoryForUser(auth.userId);
  await clearOwnReactionsForUser(auth.userId);
  await clearAutoNativesForUser(auth.userId);
  await forgetAccount(auth.userId);
  await clearAuth();
  await clearPendingDeletion();
}

async function requestDeletion(auth: AuthState): Promise<boolean> {
  const body = auth.enrollHash ? { sig: toBase64Url(await signWithDeviceKey(auth.provider, retireMessage(LOG_NAME, fromBase64Url(auth.enrollHash)))) } : {};
  const reply = await apiRequest("/v2/auth/delete", { method: "POST", token: auth.token, body, keepalive: true });
  if (reply.status === 202) return true;
  if (reply.status === 401 && apiErrorString(reply.body) === "account_deleted") return true;
  return false;
}

export async function deleteAccount(): Promise<boolean> {
  const auth = await getLiveAuth();
  if (!auth) return finishPendingDeletion();
  await storageLocalSet({ [DELETION_PENDING_KEY]: { provider: auth.provider, pk: auth.pk } satisfies DeletionPending });
  const done = await requestDeletion(auth).catch((error: unknown) => {
    logBackgroundError("deleteAccount", error);
    return false;
  });
  if (done) await clearLocalAccount(auth);
  return done;
}

/** Repeats a deletion the server has not confirmed; needs the same key's session. */
export async function finishPendingDeletion(): Promise<boolean> {
  const pending = (await storageLocalGet([DELETION_PENDING_KEY]))[DELETION_PENDING_KEY] as DeletionPending | undefined;
  if (!pending) return false;
  const auth = await getLiveAuth();
  const key = await getDeviceKey(pending.provider);
  if (!auth || auth.provider !== pending.provider || auth.pk !== pending.pk || !key) return false;
  const done = await requestDeletion(auth).catch(() => false);
  if (done) await clearLocalAccount(auth);
  return done;
}

export { INITIAL_ORIGIN };
