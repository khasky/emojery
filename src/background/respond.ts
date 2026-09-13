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

type SendResponse = (response: RuntimeResponse) => void;

/**
 * Answer with whatever `work` resolves to; a rejection answers `error` under
 * `scope`, classified by `classify` (every failure is `unavailable` unless the
 * caller can tell more, as the count read does with apiErrorCode).
 */
export function respondWith(sendResponse: SendResponse, scope: string, work: () => Promise<RuntimeResponse>, classify: (error: unknown) => RuntimeErrorCode = () => "unavailable"): void {
  work()
    .then(sendResponse)
    .catch((error: unknown) => sendResponse(errorResponse(classify(error), scope, error)));
}

/**
 * Run `work` under the signed-in account. A signed-out session answers with the
 * caller's empty payload (`authed: false`); a FAILED one answers `error`, so the
 * popup shows "could not load" rather than a sign-in prompt to a signed-in user.
 */
export function respondAuthed(sendResponse: SendResponse, emptyResponse: RuntimeResponse, work: (userId: string) => Promise<RuntimeResponse>, scope: string): void {
  respondWith(sendResponse, scope, async () => {
    const auth = await getAuth();
    return auth ? work(auth.userId) : emptyResponse;
  });
}
