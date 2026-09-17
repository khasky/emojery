// SPDX-License-Identifier: GPL-3.0-or-later
// Extension-local auth session state.

import { AUTH_KEY, isAuthSessionLive } from "../shared/auth-session";
import { API_BASE } from "../shared/config";
import { defined } from "../shared/defined";
import { deadlineSignal } from "../shared/fetch-deadline";
import type { SignInRefusal } from "../shared/messages";
import { isProviderId, type OidcProvider } from "../shared/oidc-providers";
import { clearAutoNativesForUser, clearOwnReactionsForUser } from "../shared/storage";
import { identityRedirectUrl, launchWebAuthFlow, storageLocalGet, storageLocalRemove, storageLocalSet, storageSessionGet, storageSessionRemove, storageSessionSet } from "../shared/webext";
import { clearAccountKey, clearAccountKeys, ensureAccountKey, signInNonce } from "./account-keys";
import { apiErrorString, apiRequest, isRecord, requestLanguage } from "./api-client";
import { logBackgroundError } from "./debug";
import { clearEpochKeysForUser } from "./epoch-keys";
import { clearHistory, clearHistoryForUser } from "./history";
import { bytesToBase64Url } from "./vote-signing";
import { clearQueuedVotes } from "./votequeue";

// The exchange registers the device's account key on a first sign-in, which the
// API takes tens of seconds to do; the default deadline would cut it off.
const EXCHANGE_TIMEOUT_MS = 90_000;

export interface AuthState {
  userId: string;
  token: string;
  /** Seconds-epoch expiry. */
  expiresAt: number;
  /** The provider the account signed in with; the popup labels the account by it. */
  provider: OidcProvider;
  /** Length of one key epoch in ms, as the API stated it at sign-in - the drain
   *  derives the epoch number of every vote from it (background/epoch-keys.ts). */
  epochMs: number;
}

// Every field the rest of the extension relies on, checked before the record is
// trusted: shared/auth-session.ts reads a non-finite `expiresAt` as expired,
// `userId` scopes the own-reaction and auto-native stores, so a missing one would
// silently widen their lookups across accounts, and a session without `epochMs`
// cannot sign a vote. A record the email-code builds wrote lacks the last two,
// so it reads as signed out and the account signs in again through a provider.
function isStoredAuthState(value: unknown): value is AuthState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === "string" && record.token.length > 0 && typeof record.userId === "string" && record.userId.length > 0 && typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) && isProviderId(record.provider) && typeof record.epochMs === "number" && record.epochMs > 0;
}

export async function getAuth(): Promise<AuthState | null> {
  const stored = await storageLocalGet([AUTH_KEY]);
  const auth = stored[AUTH_KEY];
  if (!isStoredAuthState(auth)) {
    // A record this malformed can never be repaired into a usable session, and
    // leaving it behind means re-reading the same garbage on every call.
    if (auth !== undefined) await storageLocalRemove([AUTH_KEY]);
    return null;
  }
  if (!isAuthSessionLive(auth.expiresAt)) {
    await storageLocalRemove([AUTH_KEY]);
    return null;
  }
  return auth;
}

async function setAuth(auth: AuthState): Promise<void> {
  await storageLocalSet({ [AUTH_KEY]: auth });
}

export async function clearAuth(): Promise<void> {
  await storageLocalRemove([AUTH_KEY]);
}

export type SignInResult = { ok: true } | { ok: false; refusal: SignInRefusal };

// What the API's `#error=` fragment becomes on screen. The API's `error` string
// is a machine diagnostic that stays in the background's request log; the ones
// matched below are the refusals whose copy differs from the generic one.
const CALLBACK_REFUSALS: Record<string, SignInRefusal> = {
  access_denied: "provider_denied",
  oidc_upstream_failed: "provider_denied",
  oidc_token_invalid: "provider_denied",
  enroll_unavailable: "enrollment_failed",
};

// The same for a refused exchange, keyed by `status error`. The status is part of
// the key so an error string is never trusted on a status it does not belong to.
const EXCHANGE_REFUSALS: Record<string, SignInRefusal> = {
  "403 client_outdated": "client_outdated",
  "409 epoch_key_limit": "device_limit",
  "503 enroll_unavailable": "enrollment_failed",
};

// The identity window rejects with a message rather than a code. A closed window
// (Chrome: "The user did not approve access.", Firefox: "User cancelled or denied
// access.") is the user's choice; anything else is the flow failing to run.
function launchRefusal(error: unknown): SignInRefusal {
  const message = error instanceof Error ? error.message : String(error);
  return /approve|cancel|denied|closed/i.test(message) ? "cancelled" : "unavailable";
}

// The `#code=` / `#error=` fragment the API redirects the identity window to.
function parseCallbackFragment(responseUrl: string): { code: string } | { error: string } {
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(new URL(responseUrl).hash.replace(/^#/, ""));
  } catch {
    return { error: "malformed_callback" };
  }
  const code = params.get("code");
  if (code) return { code };
  return { error: params.get("error") || "malformed_callback" };
}

// Carries no AuthState: the session (bearer token included) is already persisted
// via setAuth and read back through getAuth, so returning it would only widen the
// credential's exposure surface.
export async function signInWithProvider(provider: OidcProvider): Promise<SignInResult> {
  const redirect = identityRedirectUrl();
  if (!redirect) return { ok: false, refusal: "unavailable" };
  // The nonce the provider signs into its token commits to this device's account
  // key; the key and the salt behind it reach the API only with the exchange,
  // after the provider has already answered, so the API cannot swap the key.
  const accountKey = await ensureAccountKey(provider);
  const nonceSalt = crypto.getRandomValues(new Uint8Array(32));
  const nonce = await signInNonce(accountKey.publicKey, nonceSalt);
  const startUrl = `${API_BASE}/auth/oidc/start?provider=${encodeURIComponent(provider)}&redirect=${encodeURIComponent(redirect)}&nonce=${nonce}`;

  let responseUrl: string | null;
  try {
    responseUrl = await launchWebAuthFlow(startUrl);
  } catch (error) {
    return { ok: false, refusal: launchRefusal(error) };
  }
  if (!responseUrl) return { ok: false, refusal: "cancelled" };

  const callback = parseCallbackFragment(responseUrl);
  if ("error" in callback) return { ok: false, refusal: CALLBACK_REFUSALS[callback.error] ?? "unavailable" };

  const reply = await apiRequest("/auth/oidc/exchange", {
    method: "POST",
    lang: requestLanguage(),
    body: { code: callback.code, accountPubkey: bytesToBase64Url(accountKey.publicKey), nonceSalt: bytesToBase64Url(nonceSalt) },
    ...defined({ signal: deadlineSignal(EXCHANGE_TIMEOUT_MS) }),
  });
  if (!reply.ok) return { ok: false, refusal: EXCHANGE_REFUSALS[`${reply.status} ${apiErrorString(reply.body)}`] ?? "unavailable" };
  // The wire field is `expiresAtSec` (seconds). The stored AuthState keeps its own
  // `expiresAt` name (documented as seconds).
  const session = reply.body;
  if (!isRecord(session) || typeof session.userId !== "string" || !session.userId || typeof session.token !== "string" || !session.token || typeof session.expiresAtSec !== "number" || !Number.isFinite(session.expiresAtSec) || typeof session.epochMs !== "number" || !(session.epochMs > 0)) {
    // A 2xx without a usable session is a contract break, not a refused code.
    logBackgroundError("signInWithProvider.session", new Error("malformed session body"));
    return { ok: false, refusal: "unavailable" };
  }
  await setAuth({ userId: session.userId, token: session.token, expiresAt: session.expiresAtSec, provider, epochMs: session.epochMs });
  return { ok: true };
}

// The providers the API offers this build, in the order the page shows them. An
// unreadable list rejects: the page has nothing to render without it.
export async function listSignInProviders(): Promise<OidcProvider[]> {
  const reply = await apiRequest("/auth/oidc/providers", { method: "GET", cache: "no-store" });
  if (!reply.ok || !isRecord(reply.body) || !Array.isArray(reply.body.providers)) throw new Error(`providers list unavailable: http ${reply.status}`);
  return reply.body.providers.filter(isProviderId);
}

// End this account's session server-side; clearing the local token alone does not.
//
// The caller clears local state regardless of the answer: a sign-out that fails
// when the network is down would strand the user signed in.
// `keepalive` so the request survives the popup closing right after the click.
export async function revokeSessionServerSide(token: string): Promise<boolean> {
  try {
    const reply = await apiRequest("/auth/logout", { method: "POST", token, lang: requestLanguage(), keepalive: true });
    // 401 means the server already considers it dead - the goal either way.
    return reply.ok || reply.status === 401;
  } catch (error) {
    logBackgroundError("revokeSessionServerSide", error);
    return false;
  }
}

const DELETION_PENDING_KEY = "deletion_pending_v1";

interface DeletionPending {
  token: string;
  /** Account the deletion belongs to, so the local wipe stays scoped to it.
   *  Absent on a marker written before this field existed - see
   *  clearLocalAccountStateAfterDeletion. */
  userId?: string;
  /** The provider the account signed in with, naming the account key to drop.
   *  Absent on a marker written before this field existed. */
  provider?: OidcProvider;
  /** The token's own seconds-epoch expiry, copied from AuthState. This record is
   *  the one place a bearer token outlives clearAuth(), so a marker whose token has
   *  already expired is dropped rather than kept around. Absent on a marker written
   *  before this field existed - those keep the old open-ended behaviour rather than
   *  being dropped on sight. */
  expiresAt?: number;
}

async function setDeletionPending(token: string, userId: string, provider: OidcProvider, expiresAt: number): Promise<void> {
  await storageSessionSet({ [DELETION_PENDING_KEY]: { token, userId, provider, expiresAt } satisfies DeletionPending });
}

async function getDeletionPending(): Promise<DeletionPending | null> {
  // The marker lives in storage.session (trusted contexts only). A copy written by
  // an older version may still sit in storage.local, so fall back to it - an
  // interrupted deletion still resumes, and clearPendingDeletion below sweeps both.
  const stored = await storageSessionGet([DELETION_PENDING_KEY]);
  let pending = stored[DELETION_PENDING_KEY] as DeletionPending | undefined;
  if (!pending) {
    const legacy = await storageLocalGet([DELETION_PENDING_KEY]);
    pending = legacy[DELETION_PENDING_KEY] as DeletionPending | undefined;
  }
  if (!pending || typeof pending.token !== "string") return null;
  if (typeof pending.expiresAt === "number" && !isAuthSessionLive(pending.expiresAt)) {
    // Past its expiry the token can no longer authenticate the retry this marker
    // exists for, so keeping the copy buys nothing and only widens exposure.
    await clearPendingDeletion();
    return null;
  }
  const out: DeletionPending = { token: pending.token };
  if (typeof pending.userId === "string" && pending.userId) out.userId = pending.userId;
  if (isProviderId(pending.provider)) out.provider = pending.provider;
  return out;
}

// Drop the deletion-resume token copy. Called on fresh install so a reinstall
// never inherits a stale token; the deletion flow clears it on completion. Removes
// the local copy too, in case an older version wrote the marker there.
export async function clearPendingDeletion(): Promise<void> {
  await storageSessionRemove([DELETION_PENDING_KEY]);
  await storageLocalRemove([DELETION_PENDING_KEY]);
}

async function requestAccountDeletion(token: string): Promise<boolean> {
  try {
    const lang = requestLanguage();
    const reply = await apiRequest("/auth/delete", { method: "POST", token, lang, body: { ...(lang ? { lang } : {}) }, keepalive: true });
    return reply.ok || reply.status === 401;
  } catch (error) {
    logBackgroundError("requestAccountDeletion", error);
    return false;
  }
}

// Deleting ONE account must not take another's device-local data with it: every
// store below is userId-scoped, so a second account signed in on the same browser
// keeps its records. `userId` is undefined only for a pre-`userId` deletion-resume
// marker, where nothing names the account - history then falls back to the
// wholesale wipe, and the two capped, self-evicting map stores keep the deleted
// account's inert entries rather than taking a live account's with them.
async function clearLocalAccountStateAfterDeletion(userId: string | undefined, provider: OidcProvider | undefined): Promise<void> {
  // The account key is per provider, not per account: the one this account signed
  // in through goes, so the next sign-in registers a fresh device. A marker that
  // names no provider drops every provider's key, as history falls back below.
  if (provider) await clearAccountKey(provider);
  else await clearAccountKeys();
  if (userId) {
    await clearHistoryForUser(userId);
    await clearOwnReactionsForUser(userId);
    await clearAutoNativesForUser(userId);
    // The signing keys go with the account and only with it (background/epoch-keys.ts).
    await clearEpochKeysForUser(userId);
  } else {
    await clearHistory();
  }
  // Votes still queued outlive the session now, so the deleted account's pending
  // entries need a wipe of their own - nothing else would ever send or clear them.
  await clearQueuedVotes(userId);
  await clearAuth();
  // Last: a wipe that throws (IndexedDB unavailable) must leave the resume marker
  // behind, or nothing is left to retry the deletion the server already performed.
  await clearPendingDeletion();
}

export async function deleteAccount(): Promise<boolean> {
  const auth = await getAuth();
  if (!auth) return finishPendingDeletion();
  await setDeletionPending(auth.token, auth.userId, auth.provider, auth.expiresAt);
  const done = await requestAccountDeletion(auth.token);
  if (done) await clearLocalAccountStateAfterDeletion(auth.userId, auth.provider);
  return done;
}

export async function finishPendingDeletion(): Promise<boolean> {
  const pending = await getDeletionPending();
  if (!pending) return false;
  const done = await requestAccountDeletion(pending.token);
  if (done) await clearLocalAccountStateAfterDeletion(pending.userId, pending.provider);
  return done;
}
