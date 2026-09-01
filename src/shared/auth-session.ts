// SPDX-License-Identifier: GPL-3.0-or-later
// The auth session record's storage key and expiry semantics. Owned by
// background/identity.ts; the KEY is shared here so the storage-change listeners
// that must not import background code (ui/mount.ts, entrypoints/background.ts)
// watch the same one. They only test for the key's presence: the record itself
// carries the bearer token, so nothing outside identity.ts reads its value -
// content scripts ask the background instead (ui/messaging.ts activeUserId).

export const AUTH_KEY = "auth_v1";

// `expiresAt` is seconds-epoch (see AuthState in background/identity.ts).
// NaN-safe: a non-numeric value yields NaN comparisons, which read as expired.
export function isAuthSessionLive(expiresAt: number): boolean {
  return expiresAt * 1000 > Date.now();
}
