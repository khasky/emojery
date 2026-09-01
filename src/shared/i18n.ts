// SPDX-License-Identifier: GPL-3.0-or-later
//
// Thin wrapper around the WebExtensions i18n API. The browser picks the locale
// at install/load from its UI language; missing keys fall back to the
// manifest's `default_locale` (`en`). The emoji picker's lazy metadata follows
// the same mapping (see `shared/emoji-meta.ts`).
//
// Why a wrapper: `chrome.i18n` is undefined in Vitest/jsdom, so it falls back to
// the imported English source of truth - which also types `I18nKey`. Chrome's
// named-placeholder format is opaque on that path, so positional substitution is
// re-implemented to match.

// The generated slim dictionary ({ message, placeholders? } per key - no
// translator `description` prose), emitted by scripts/copy-emoji-locales.mjs
// from public/_locales/en/messages.json.
import enMessages from "./__generated__/messages-en.json";

export type I18nKey = keyof typeof enMessages;

// Build-time constant from wxt.config.ts, false in every BUILD. Inside an extension
// `chrome.i18n.getMessage` always answers - the manifest's `default_locale` guarantees
// English for any key the browser's UI language lacks - so the dictionary below is
// reachable ONLY from Vitest/jsdom, where the constant is undefined. Folding it to a
// literal lets rollup drop the whole JSON module out of every content script, on every
// page load of a supported site. scripts/check-bundle-budget.mjs holds that line: it
// fails the build if the dictionary comes back.
declare const __EM_I18N_FALLBACK__: boolean;
const HAS_FALLBACK_DICT: boolean = typeof __EM_I18N_FALLBACK__ === "undefined" || __EM_I18N_FALLBACK__;

const PLACEHOLDER_RE = /\$[A-Z_]+\$/gi;

/**
 * Look up a localized message. `substitutions` matches
 * `chrome.i18n.getMessage` (single string or array, applied in order). Falls
 * back to English outside an extension context, then to the key itself.
 */
export function t(key: I18nKey, substitutions?: string | string[]): string {
  if (typeof chrome !== "undefined" && chrome.i18n?.getMessage) {
    const msg = chrome.i18n.getMessage(key, substitutions);
    if (msg) return msg;
  }
  return fallback(key, substitutions);
}

function fallback(key: I18nKey, substitutions?: string | string[]): string {
  if (!HAS_FALLBACK_DICT) return key;
  const entry = enMessages[key];
  if (!entry?.message) return key;
  const subs = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  if (subs.length === 0) return entry.message;
  let i = 0;
  return entry.message.replace(PLACEHOLDER_RE, () => subs[i++] ?? "");
}
