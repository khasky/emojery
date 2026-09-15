// SPDX-License-Identifier: GPL-3.0-or-later
//
// Endpoints. The define below is injected by wxt.config.ts, which owns which
// backend a build talks to - the production origin only in the `production` build
// mode, a WXT_API_BASE override otherwise, staging as the default; the origins
// themselves come from shared/api-origins.ts, which that config reads too.

import { STAGING_API_BASE } from "./api-origins";

declare const __EM_API_BASE__: string;

// Staging is also the fallback outside a WXT build (vitest, where the define is
// undefined): a test that reaches the network at all must not reach production.
export const API_BASE: string = (typeof __EM_API_BASE__ !== "undefined" && __EM_API_BASE__) || STAGING_API_BASE;

// TTL for the local read-through counts cache, read by getCachedCounts in
// shared/counts-cache.ts.
export const READ_CACHE_TTL_MS = 60_000;

// Deadline for a single outbound fetch. Every caller sits under a memoized promise, so a
// fetch that never settles pins that slot for the life of the service worker or page.
export const API_TIMEOUT_MS = 10_000;

// Deadline for any page -> background round trip: content scripts, and the popup and auth
// page through sendRuntimeMessage. The background can be a cold service worker doing
// IndexedDB work, so this is looser than the API one.
export const RUNTIME_MESSAGE_TIMEOUT_MS = 15_000;

// How long a whole counts read gets, retry included. Derived from the wait above so the
// two can't drift: a read that outlives that wait shows an error and then writes counts
// nobody is waiting for. The gap covers a cold worker and the cache write.
export const COUNTS_READ_BUDGET_MS = RUNTIME_MESSAGE_TIMEOUT_MS - 3_000;
