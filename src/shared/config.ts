// SPDX-License-Identifier: GPL-3.0-or-later
//
// Endpoints. Both defines below are injected by wxt.config.ts, which owns the
// build-time WXT_API_BASE override rules; the origins themselves come from
// shared/api-origins.ts, which that config reads too.

import { PRODUCTION_API_BASE, STAGING_API_BASE } from "./api-origins";

declare const __EM_STAGING_BUILD__: boolean;
declare const __EM_API_BASE_OVERRIDE__: string;

// True only in a `--mode staging` build. Folds to a literal at build time, so a
// branch behind it drops out of the production bundle along with the module it
// reaches. Currently only picks the API base below.
const IS_STAGING_BUILD: boolean = typeof __EM_STAGING_BUILD__ !== "undefined" && __EM_STAGING_BUILD__;

const DEFAULT_API_BASE = IS_STAGING_BUILD ? STAGING_API_BASE : PRODUCTION_API_BASE;

export const API_BASE: string = (typeof __EM_API_BASE_OVERRIDE__ !== "undefined" && __EM_API_BASE_OVERRIDE__) || DEFAULT_API_BASE;

// TTL for the local read-through counts cache (see shared/counts-cache.ts getCachedCounts).
export const READ_CACHE_TTL_MS = 60_000;

// Deadline for a single outbound fetch. Every caller sits under a memoized promise, so a
// fetch that never settles pins that slot for the life of the service worker or page.
export const API_TIMEOUT_MS = 10_000;

// Deadline for any page -> background round trip: content scripts, and the popup and auth
// page through sendRuntimeMessage. The background can be a cold service worker doing
// IndexedDB work, so this is deliberately looser than the API one.
export const RUNTIME_MESSAGE_TIMEOUT_MS = 15_000;
