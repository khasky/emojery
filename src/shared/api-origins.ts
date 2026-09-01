// SPDX-License-Identifier: GPL-3.0-or-later
//
// Single source of truth for the backend origins - read by wxt.config.ts (the manifest
// `host_permissions` and the CSP `connect-src`) and by shared/config.ts (the origin every
// runtime fetch goes to); a drift between two literals builds green and dies at runtime.
// Not in config.ts: WXT evaluates wxt.config.ts in Node, so this stays pure data - no
// chrome.*, no DOM.

export const PRODUCTION_API_BASE = "https://api.emojery.app";

// `pnpm build:staging` targets this origin with no env file.
export const STAGING_API_BASE = "https://api-staging.emojery.app";
