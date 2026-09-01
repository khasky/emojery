// SPDX-License-Identifier: GPL-3.0-or-later
//
// How the background answers a runtime message that did not succeed. Outside the
// router so "empty result" and "could not read it" stay distinguishable - and
// testable without booting the service worker.

import type { RuntimeErrorCode, RuntimeResponse } from "../shared/messages";
import { logBackgroundError } from "./debug";
import { getAuth } from "./identity";

// Fixed, credential-free diagnostics - never user-facing. The UI renders its own
// localized copy from `code` (shared/error-copy.ts); developer detail goes to the
// dev debug log (debug.ts), never over the wire.
const ERROR_MESSAGES: Record<RuntimeErrorCode, string> = {
  network: "network unavailable",
  rate_limited: "rate limited",
  server: "server error",
  unavailable: "operation failed",
};

export function errorResponse(code: RuntimeErrorCode, scope: string, cause?: unknown): RuntimeResponse {
  if (cause !== undefined) logBackgroundError(scope, cause);
  return { type: "error", code, message: ERROR_MESSAGES[code] };
}

/**
 * Run `work` under the signed-in account. A signed-out session answers with the
 * caller's empty payload (`authed: false`); a FAILED one answers `error`, so the
 * popup shows "could not load" rather than a sign-in prompt to a signed-in user.
 */
export function respondAuthed(sendResponse: (response: RuntimeResponse) => void, emptyResponse: RuntimeResponse, work: (userId: string) => Promise<RuntimeResponse>, scope: string): void {
  (async () => {
    const auth = await getAuth();
    if (!auth) {
      sendResponse(emptyResponse);
      return;
    }
    sendResponse(await work(auth.userId));
  })().catch((error: unknown) => sendResponse(errorResponse("unavailable", scope, error)));
}
