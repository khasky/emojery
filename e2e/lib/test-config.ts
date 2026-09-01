// SPDX-License-Identifier: GPL-3.0-or-later
//
// What a run is configured WITH: the fixture URLs, the test credentials, and the
// reaction glyphs the authed flows react with. `load-env.ts` puts the dotenv
// files into `process.env`; this module is what reads them back.
//
// A LEAF on purpose - no Playwright, no page, no browser. Anything here that grew
// a `Page` parameter would belong in reaction-surface.ts instead.

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

// Test credentials, read from the git-ignored `.env.e2e.local`; never committed.
function addressTemplate(): string {
  return process.env.E2E_AUTH_EMAIL?.trim().toLowerCase() ?? "";
}

export function authOtp(): string {
  return process.env.E2E_AUTH_OTP?.trim() ?? "";
}

// A code guaranteed to differ from `otp`.
export function wrongOtpFor(otp: string): string {
  return (otp.startsWith("0") ? "1" : "0") + otp.slice(1);
}

// One address per purpose, resolved ONCE per WORKER PROCESS, so a spec that locks
// or destroys its state never touches a sibling's. Playwright restarts the worker
// after a failure, so a retried run resolves fresh values. Append
// TEST_WORKER_INDEX if the suite ever runs parallel.
const RUN_STAMP = Date.now();
export function authEmail(purpose = "primary"): string {
  const template = addressTemplate();
  return template ? template.replace("{id}", `${purpose}-${RUN_STAMP}`) : "";
}

export function otpSkipReason(what: string): string {
  return `Set E2E_AUTH_EMAIL + E2E_AUTH_OTP (test credentials) to run ${what}.`;
}

// Authed gap specs `test.skip` themselves off when the test credentials are
// absent, so the suite stays green without them. A malformed value is NOT
// pre-rejected here - the sign-in it is used for is where it fails.
export function authConfigured(): boolean {
  return isValidAddressTemplate(addressTemplate()) && authOtp().length > 0;
}

// Callers need distinct values; a template with no `{id}` cannot give them.
function isValidAddressTemplate(template: string): boolean {
  return /^[^@\s]*\{id\}[^@\s]*@[a-z0-9.-]+\.[a-z]+$/.test(template);
}

// How long the test waits for an updated public count to become readable
// (reaction-surface.ts reloadAndReadTotal). A narrower budget expired on a live run.
export const COUNT_CACHE_WAIT_MS = Number(process.env.E2E_COUNT_CACHE_WAIT_MS ?? 210_000);
