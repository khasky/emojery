// SPDX-License-Identifier: GPL-3.0-or-later
//
// What a run is configured WITH: the fixture URLs, the sign-in fixtures, and the
// reaction glyphs the authed flows react with. `load-env.ts` puts the dotenv
// files into `process.env`; this module is what reads them back.
//
// A LEAF - no Playwright at runtime, no page, no browser. Anything here that
// grew a `Page` parameter would belong in reaction-surface.ts instead; the one
// below is a type, handed straight through to the sign-in resolver.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

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
//   signInAccount(purpose: string): string - the account the flow named by `purpose`
//                                            signs in as, distinct per purpose and per
//                                            process, so a spec that destroys its
//                                            account never touches a sibling's;
//   completeSignIn(window, account, outcome) - drives the test provider's
//                                            window (the page identity.launchWebAuthFlow
//                                            opened) to "accepted" or "refused" for
//                                            that account; what the window asks for
//                                            is the resolver's business.
// Unset => every authed spec skips. Set but unloadable => the run fails naming the
// path; the module is never committed (keep it under .playwright/ or outside the repo).
export type SignInOutcome = "accepted" | "refused";

interface SignInResolver {
  signInAccount(purpose: string): string;
  completeSignIn(window: Page, account: string, outcome: SignInOutcome): Promise<void>;
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
  if (!isSignInResolver(exported)) throw new Error(`E2E_SIGNIN_RESOLVER (${modulePath}) must export signInAccount(purpose) and completeSignIn(window, account, outcome).`);
  loadedResolver = exported;
  return exported;
}

function isSignInResolver(value: unknown): value is SignInResolver {
  const candidate = value as Partial<SignInResolver> | null;
  return typeof candidate?.signInAccount === "function" && typeof candidate?.completeSignIn === "function";
}

// Drives the test provider's window to `outcome` for `account`. Every caller sits
// behind authConfigured(), so a missing resolver here is a misconfigured run, not
// a skipped one - it fails loud rather than leaving the window open.
export function completeSignIn(window: Page, account: string, outcome: SignInOutcome = "accepted"): Promise<void> {
  return signInResolver().completeSignIn(window, account, outcome);
}

// One account per purpose. Playwright restarts the worker after a failure, so a
// retried run resolves fresh values through the resolver.
export function authAccount(purpose = "primary"): string {
  const account = signInResolver().signInAccount(purpose).trim();
  if (!account) throw new Error(`The sign-in resolver returned no account for "${purpose}".`);
  return account;
}

export function signInSkipReason(what: string): string {
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
