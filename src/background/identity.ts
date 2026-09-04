// SPDX-License-Identifier: GPL-3.0-or-later
// Extension-local auth session state.

import { AUTH_KEY, isAuthSessionLive } from "../shared/auth-session";
import { API_BASE } from "../shared/config";
import { normalizeLanguageTag } from "../shared/language-tag";
import { clearAutoNativesForUser, clearOwnReactionsForUser } from "../shared/storage";
import { storageLocalGet, storageLocalRemove, storageLocalSet, storageSessionGet, storageSessionRemove, storageSessionSet } from "../shared/webext";
import { clientSecurityHeaders } from "./client-security";
import { apiFetch, logBackgroundError } from "./debug";
import { clearHistory, clearHistoryForUser } from "./history";
import { parseRetryAfterSeconds } from "./retry-after";

export interface AuthState {
  userId: string;
  token: string;
  /** Seconds-epoch expiry. */
  expiresAt: number;
  /** Sign-in email, stored locally so the popup can label the account. Optional for older sessions. */
  email?: string;
}

// Every field the rest of the extension relies on, checked before the record is
// trusted: shared/auth-session.ts reads a non-finite `expiresAt` as expired, and
// `userId` scopes the own-reaction and auto-native stores, so a missing one would
// silently widen their lookups across accounts.
function isStoredAuthState(value: unknown): value is AuthState {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.token === "string" && record.token.length > 0 && typeof record.userId === "string" && record.userId.length > 0 && typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt);
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

interface RequestOtpResult {
  ok: boolean;
  /** HTTP status for UI-specific failure handling. */
  status: number;
  error?: string;
  /** Seconds the caller should wait before retrying. */
  retryAfterSeconds?: number;
}

// The UI language the auth endpoints get, as an `accept-language` header and a
// `lang` body field. Held to a well-formed BCP-47 tag by normalizeLanguageTag
// (shared/language-tag), the same validator the vote path uses, so region survives
// (`pt-BR` stays `pt-BR`) and only a malformed value is dropped. Empty string,
// not undefined - callers gate on falsiness and omit the field.
export function authRequestLanguage(): string {
  return normalizeLanguageTag(typeof navigator !== "undefined" ? navigator.language : undefined) ?? "";
}

// Client identity headers used by API requests. Not secrets.
export function extensionClientHeaders(): Record<string, string> {
  const runtime = globalThis.chrome?.runtime;
  const manifest = runtime?.getManifest?.();
  const runtimeOrigin = extensionRuntimeOrigin(runtime);
  return {
    "x-emojery-client": "extension",
    "x-emojery-client-version": manifest?.version ?? "0.0.0",
    ...(runtime?.id ? { "x-emojery-runtime-id": runtime.id } : {}),
    ...(runtimeOrigin ? { "x-emojery-runtime-origin": runtimeOrigin } : {}),
  };
}

// The headers every JSON POST shares - the auth endpoints here, the vote (api.ts)
// and the problem report (reports.ts). No two sources share a header name, so
// spread order never changes the result. The GET reads (api-read.ts, popular.ts)
// build their own, so a header added below reaches the POSTs only.
export async function jsonApiHeaders(opts: { token?: string; lang?: string } = {}): Promise<Record<string, string>> {
  // Deliberate absorb: these headers are best-effort, and the request goes out without them.
  const securityHeaders = await clientSecurityHeaders().catch(() => ({}));
  return {
    "content-type": "application/json",
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...extensionClientHeaders(),
    ...(opts.lang ? { "accept-language": opts.lang } : {}),
    ...securityHeaders,
  };
}

function extensionRuntimeOrigin(runtime: typeof chrome.runtime | undefined): string {
  try {
    const root = runtime?.getURL?.("");
    if (!root) return "";
    const url = new URL(root);
    if (url.protocol === "chrome-extension:" || url.protocol === "moz-extension:" || url.protocol === "safari-web-extension:") {
      return `${url.protocol}//${url.host}`;
    }
    return url.origin;
  } catch {
    return "";
  }
}

async function postRequestOtp(email: string, lang: string): Promise<Response> {
  return apiFetch(`${API_BASE}/auth/request-otp`, {
    method: "POST",
    headers: await jsonApiHeaders({ lang }),
    body: JSON.stringify({ email, ...(lang ? { lang } : {}) }),
  });
}

export async function requestOtp(email: string): Promise<RequestOtpResult> {
  const lang = authRequestLanguage();
  const res = await postRequestOtp(email, lang);

  if (res.ok) return { ok: true, status: res.status };
  const err = (await res.json().catch(() => ({}))) as { error?: string };
  // The `retry-after` header is the only source of a delay; the response body
  // carries an `error` string and nothing the client reads. Absent header means
  // no delay to surface - the caller falls back to its own cooldown.
  const retryAfterSeconds = parseRetryAfterSeconds(res.headers.get("retry-after"));
  return {
    ok: false,
    status: res.status,
    ...(err.error ? { error: err.error } : {}),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

// Deliberately carries no AuthState: the session (bearer token included) is
// already persisted via setAuth and read back through getAuth, so returning it
// would only widen the credential's exposure surface.
interface VerifyOtpResult {
  ok: boolean;
  status: number;
  error?: string;
}

export async function verifyOtp(email: string, code: string): Promise<VerifyOtpResult> {
  const res = await apiFetch(`${API_BASE}/auth/verify-otp`, {
    method: "POST",
    headers: await jsonApiHeaders({ lang: authRequestLanguage() }),
    body: JSON.stringify({ email, code }),
  });
  if (res.ok) {
    // The wire field is `expiresAtSec` (seconds). The stored AuthState keeps its
    // own `expiresAt` name (documented as seconds), so no migration of a saved
    // `auth_v1` record is needed.
    const session = (await res.json().catch(() => null)) as { userId?: unknown; token?: unknown; expiresAtSec?: unknown } | null;
    if (!session || typeof session.userId !== "string" || !session.userId || typeof session.token !== "string" || !session.token || typeof session.expiresAtSec !== "number" || !Number.isFinite(session.expiresAtSec)) {
      return { ok: false, status: res.status, error: "invalid_session" };
    }
    const authState: AuthState = { userId: session.userId, token: session.token, expiresAt: session.expiresAtSec, email };
    await setAuth(authState);
    return { ok: true, status: res.status };
  }
  const err = (await res.json().catch(() => ({}))) as { error?: string };
  return {
    ok: false,
    status: res.status,
    ...(err.error ? { error: err.error } : {}),
  };
}

// End this account's session server-side; clearing the local token alone does not.
//
// Best-effort by design: the caller clears local state regardless, because a
// sign-out that fails when the network is down would strand the user signed in.
// `keepalive` so the request survives the popup closing right after the click.
export async function revokeSessionServerSide(token: string): Promise<boolean> {
  try {
    const res = await apiFetch(`${API_BASE}/auth/logout`, {
      method: "POST",
      headers: await jsonApiHeaders({ token, lang: authRequestLanguage() }),
      keepalive: true,
    });
    // 401 means the server already considers it dead - the goal either way.
    return res.ok || res.status === 401;
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
  /** Sign-in address, carried so a deletion that only completes on a later retry
   *  still sends it. Absent for a session signed in before the address was stored
   *  locally. */
  email?: string;
  /** The token's own seconds-epoch expiry, copied from AuthState. This record is
   *  the one place a bearer token outlives clearAuth(), so a marker whose token has
   *  already expired is dropped rather than kept around. Absent on a marker written
   *  before this field existed - those keep the old open-ended behaviour rather than
   *  being dropped on sight. */
  expiresAt?: number;
}

async function setDeletionPending(token: string, userId: string, email: string | undefined, expiresAt: number): Promise<void> {
  await storageSessionSet({ [DELETION_PENDING_KEY]: { token, userId, ...(email ? { email } : {}), expiresAt } satisfies DeletionPending });
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
  if (typeof pending.email === "string" && pending.email) out.email = pending.email;
  return out;
}

// Drop the deletion-resume token copy. Called on fresh install so a reinstall
// never inherits a stale token; the deletion flow clears it on completion. Removes
// the local copy too, in case an older version wrote the marker there.
export async function clearPendingDeletion(): Promise<void> {
  await storageSessionRemove([DELETION_PENDING_KEY]);
  await storageLocalRemove([DELETION_PENDING_KEY]);
}

// `email` is optional; the deletion does not depend on it.
async function requestAccountDeletion(token: string, email: string | undefined): Promise<boolean> {
  try {
    const lang = authRequestLanguage();
    const res = await apiFetch(`${API_BASE}/auth/delete`, {
      method: "POST",
      headers: await jsonApiHeaders({ token, lang }),
      body: JSON.stringify({ ...(email ? { email } : {}), ...(lang ? { lang } : {}) }),
      keepalive: true,
    });
    return res.ok || res.status === 401;
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
async function clearLocalAccountStateAfterDeletion(userId: string | undefined): Promise<void> {
  if (userId) {
    await clearHistoryForUser(userId);
    await clearOwnReactionsForUser(userId);
    await clearAutoNativesForUser(userId);
  } else {
    await clearHistory();
  }
  await clearAuth();
  // Last: a wipe that throws (IndexedDB unavailable) must leave the resume marker
  // behind, or nothing is left to retry the deletion the server already performed.
  await clearPendingDeletion();
}

export async function deleteAccount(): Promise<boolean> {
  const auth = await getAuth();
  if (!auth) return finishPendingDeletion();
  await setDeletionPending(auth.token, auth.userId, auth.email, auth.expiresAt);
  const done = await requestAccountDeletion(auth.token, auth.email);
  if (done) await clearLocalAccountStateAfterDeletion(auth.userId);
  return done;
}

export async function finishPendingDeletion(): Promise<boolean> {
  const pending = await getDeletionPending();
  if (!pending) return false;
  const done = await requestAccountDeletion(pending.token, pending.email);
  if (done) await clearLocalAccountStateAfterDeletion(pending.userId);
  return done;
}
