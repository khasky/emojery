// SPDX-License-Identifier: GPL-3.0-or-later
//
// What a run is configured WITH: the fixture URLs, the sign-in fixtures, and the
// reaction glyphs the authed flows react with. `load-env.ts` puts the dotenv
// files into `process.env`; this module is what reads them back.
//
// A LEAF on purpose - no Playwright, no page, no browser. Anything here that grew
// a `Page` parameter would belong in reaction-surface.ts instead.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Picker emoji glyphs the authed flows react with. ❤️ is U+2764 + VS16 - the
// exact sequence the picker renders.
export const REACTIONS = {
  heart: "❤️",
  fire: "\u{1F525}",
} as const;

// Search terms (English locale) that surface each reaction as the first picker
// result, so a specific emoji is picked deterministically instead of by grid index.
const REACTION_SEARCH: Record<string, string> = {
  [REACTIONS.heart]: "love",
  [REACTIONS.fire]: "fire",
};

export function searchTermFor(emoji: string): string {
  return REACTION_SEARCH[emoji] ?? emoji;
}

// Require a fixture URL from the named env key (no hardcoded fallback): a
// missing/blank fixture fails loudly instead of silently testing a stale default.
export function requiredEnvUrl(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Set ${key} in .env.e2e.example (the checked-in fixture URLs) or override it in .env.e2e / .env.e2e.local.`);
  }
  try {
    return new URL(value).toString();
  } catch {
    throw new Error(`${key} must be a valid absolute URL.`);
  }
}

// Single-target content URL for a site, from E2E_URL_<SITE>.
export function envUrl(site: string): string {
  return requiredEnvUrl(`E2E_URL_${site}`);
}

// Stable single-target GitHub surface: the picker mounts on the repo header
// without any platform login, so it is the safe reaction target for these specs.
export function githubUrl(): string {
  return envUrl("GITHUB");
}

export function gitlabUrl(): string {
  return envUrl("GITLAB");
}

// Sign-in fixtures come from a resolver module outside the tree: E2E_SIGNIN_RESOLVER
// names a CommonJS or ES module (absolute, or relative to the repo root) exporting
//   signInEmail(purpose: string): string  - an address for the flow named by `purpose`,
//                                           distinct per purpose and per process, so a
//                                           spec that locks or destroys its state never
//                                           touches a sibling's;
//   signInCode(email: string): string     - the code auth.html accepts for that address.
// Unset => every authed spec skips. Set but unloadable => the run fails naming the
// path; the module is never committed (keep it under .playwright/ or outside the repo).
interface SignInResolver {
  signInEmail(purpose: string): string;
  signInCode(email: string): string;
}

const nodeRequire = createRequire(import.meta.url);
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
let loadedResolver: SignInResolver | undefined;

function resolverPath(): string {
  return process.env.E2E_SIGNIN_RESOLVER?.trim() ?? "";
}

function signInResolver(): SignInResolver {
  if (loadedResolver) return loadedResolver;
  const configured = resolverPath();
  if (!configured) throw new Error("No sign-in resolver configured. Set E2E_SIGNIN_RESOLVER in .env.e2e.local (see .env.e2e.example).");
  const modulePath = resolve(REPO_ROOT, configured);
  const loaded: unknown = nodeRequire(modulePath);
  const exported = (loaded as { default?: unknown }).default ?? loaded;
  if (!isSignInResolver(exported)) throw new Error(`E2E_SIGNIN_RESOLVER (${modulePath}) must export signInEmail(purpose) and signInCode(email).`);
  loadedResolver = exported;
  return exported;
}

function isSignInResolver(value: unknown): value is SignInResolver {
  const candidate = value as Partial<SignInResolver> | null;
  return typeof candidate?.signInEmail === "function" && typeof candidate?.signInCode === "function";
}

// The sign-in code for `email`. Every caller sits behind authConfigured(), so a
// missing resolver here is a misconfigured run, not a skipped one - it fails loud
// rather than typing "" into the form.
export function authCode(email: string): string {
  const code = signInResolver().signInCode(email);
  if (!code) throw new Error(`The sign-in resolver returned no code for ${email}.`);
  return code;
}

// A code guaranteed to differ from `code`.
export function wrongCodeFor(code: string): string {
  return (code.startsWith("0") ? "1" : "0") + code.slice(1);
}

// One address per purpose. Playwright restarts the worker after a failure, so a
// retried run resolves fresh values through the resolver.
export function authEmail(purpose = "primary"): string {
  const email = signInResolver().signInEmail(purpose).trim().toLowerCase();
  if (!email) throw new Error(`The sign-in resolver returned no address for "${purpose}".`);
  return email;
}

export function otpSkipReason(what: string): string {
  return `Set E2E_SIGNIN_RESOLVER (see .env.e2e.example) to run ${what}.`;
}

// Authed gap specs `test.skip` themselves off when no resolver is configured, so
// the suite stays green without one. A configured but broken resolver is NOT
// pre-rejected here - the first sign-in that loads it is where it fails.
export function authConfigured(): boolean {
  return resolverPath().length > 0;
}

// How long the test waits for an updated public count to become readable
// (reaction-surface.ts reloadAndReadTotal). A narrower budget expired on a live run.
export const COUNT_CACHE_WAIT_MS = Number(process.env.E2E_COUNT_CACHE_WAIT_MS ?? 210_000);
