// SPDX-License-Identifier: GPL-3.0-or-later
//
// The one place a `RuntimeErrorCode` becomes something a user reads - the UI half of
// the contract background/respond.ts documents. Each caller picks its own fallback
// copy; the codes a user can act on (`network`, `rate_limited`, `server`) override it
// with copy that says which one it is.
//
// `unavailable` deliberately has no copy of its own: it IS the generic case, so it falls
// through to the caller's fallback rather than inventing a second way to say "something
// went wrong".

import type { I18nKey } from "./i18n";
import type { RuntimeErrorCode, RuntimeResponse } from "./messages";

const COPY: Record<RuntimeErrorCode, I18nKey | null> = {
  network: "errOffline",
  rate_limited: "errRateLimited",
  server: "errServerBusy",
  unavailable: null,
};

/** The message key for a failed runtime response, or `fallback` when the code adds nothing. */
export function errorCopyKey(code: RuntimeErrorCode | null | undefined, fallback: I18nKey): I18nKey {
  return (code && COPY[code]) || fallback;
}

/** The background's classification, when the answer was an error response at all: a
 *  wrong-shaped answer (signed out, an empty payload) carries no code, so the caller's
 *  own fallback stands. */
export function failureCode(response: RuntimeResponse | null | undefined): RuntimeErrorCode | null {
  return response?.type === "error" ? response.code : null;
}
