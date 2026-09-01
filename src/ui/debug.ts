// SPDX-License-Identifier: GPL-3.0-or-later
//
// The content script's half of the dev console channel. Its own module rather than a
// call into background/debug.ts: that one owns `apiFetch` too, and importing it here
// would carry the fetch-deadline machinery into every content bundle.

import { logScopedError } from "../shared/debug-log";

/**
 * Trace for a mount-side failure the caller deliberately absorbs. The content script
 * runs inside someone else's page, so it may not write to that page's console in a
 * shipped build - and it does not: `logScopedError` folds to nothing when
 * `__EM_DEBUG_LOG__` is false, which is every production build.
 *
 * What it buys in dev and staging: a mount that silently never appears used to leave
 * no trace at all, because every scheduling path here ends in a bare `catch(() => {})`.
 */
export function logContentError(scope: string, error: unknown): void {
  logScopedError("content", scope, error);
}
