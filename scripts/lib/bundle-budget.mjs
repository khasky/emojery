// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The two decisions behind check-bundle-budget.mjs, split out so both boundaries can be
// asserted without a build. Neither is checkable from the gate's own output: it prints the
// same line whether a bundle sits one byte under the ceiling or one over.
//
// The limits live here rather than in the gate so the test asserts the shipped numbers
// instead of a second copy of them - a copy would keep passing after the gate moved.
/** @typedef {{ maxBytes: number, maxDistinctive: number }} BundleLimits */

// Below this length a match is a common word ("Search", "Clear", a category name that also
// lives in emoji-categories.json), not evidence the dictionary shipped.
export const DISTINCTIVE_MESSAGE_LENGTH = 25;

/**
 * `maxBytes`: headroom over the largest content-script bundle (the gate prints every bundle's
 * current size when it runs). Raise it deliberately, with a note on what earned the growth.
 * `maxDistinctive`: a handful of long strings could legitimately reach a bundle another way;
 * a dictionary that shipped whole puts dozens there at once.
 * @type {BundleLimits}
 */
export const BUNDLE_LIMITS = { maxBytes: 200_000, maxDistinctive: 5 };

/**
 * The messages long enough that finding one in a bundle is evidence the whole dictionary
 * shipped, rather than a common word that reached it another way ("Search", a category name).
 * @param {Record<string, { message?: string }>} messages
 * @param {number} minLength
 * @returns {string[]}
 */
export function distinctiveMessages(messages, minLength) {
  return Object.values(messages)
    .map((entry) => entry?.message ?? "")
    .filter((message) => message.length >= minLength);
}

/**
 * What is wrong with one built content script, if anything. Both checks are strict `>`: the
 * limit itself is allowed, and only passing it is an issue.
 * @param {{ name: string, bytes: number, inlined: number }} bundle
 * @param {BundleLimits} limits
 * @returns {string[]}
 */
export function contentScriptIssues(bundle, limits) {
  const issues = [];
  if (bundle.bytes > limits.maxBytes) issues.push(`${bundle.name}: ${bundle.bytes} bytes exceeds the ${limits.maxBytes} budget`);
  if (bundle.inlined > limits.maxDistinctive) issues.push(`${bundle.name}: ${bundle.inlined} English UI messages inlined - the i18n fallback dictionary is shipping. Check __EM_I18N_FALLBACK__ in wxt.config.ts.`);
  return issues;
}
