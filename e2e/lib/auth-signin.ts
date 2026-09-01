// SPDX-License-Identifier: GPL-3.0-or-later
//
// Driving the extension's OWN auth page (auth.html) with the test credentials:
// the page's selectors, its shipped button labels, and the request-code/verify
// exchange with the retries that make it survive a real backend.
//
// A LEAF module, and deliberately so: besides the e2e suites (through
// lib/extension.ts, which re-exports it) external tooling resolves this file
// via EM_EXT_ROOT and loads it directly under plain Node, where types are
// stripped at load and imports resolve by Node's own rules. So: no relative
// imports, nothing outside `node:*` and `@playwright/test` - and keep the
// export shape stable.
//
// Nothing in CI runs that tooling, so only this single shared copy keeps a
// renamed selector or label from breaking it silently while the suite stays green.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page } from "@playwright/test";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_ROOT = resolve(__dirname, "..", "..");

const localeMessageCache = new Map<string, Record<string, { message?: string }>>();

// Read a localized UI string from the built extension's shipped locale files
// (public/_locales/<locale>/messages.json), substituting $PLACEHOLDER$ tokens in
// order. Specs assert the exact shipped copy for a locale through this.
export function localeMessage(locale: string, key: string, substitutions?: string | string[]): string {
  let messages = localeMessageCache.get(locale);
  if (!messages) {
    messages = JSON.parse(readFileSync(resolve(EXTENSION_ROOT, "public", "_locales", locale, "messages.json"), "utf8")) as Record<string, { message?: string }>;
    localeMessageCache.set(locale, messages);
  }
  const template = messages[key]?.message ?? key;
  const subs = substitutions === undefined ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
  let index = 0;
  return template.replace(/\$[A-Z_]+\$/gi, (token) => {
    const value = subs[index++];
    // Emptying an unfilled placeholder builds a locator that matches nothing and
    // reads like a copy change; name the token instead, the way a missing KEY
    // already fails loudly in enMessage below.
    if (value === undefined) throw new Error(`Missing substitution for ${token} in ${locale} message: ${key}`);
    return value;
  });
}

// The shipped EN string behind a locator, so a copy edit renames the locator
// with it instead of leaving a spec waiting on text nobody ships any more (the
// "Analytics" -> "Community insights" rename cost two suites exactly that).
// localeMessage returns the KEY when a message is missing; turn that back into a
// loud failure so a renamed KEY cannot quietly become an unmatched locator.
export function enMessage(key: string, substitutions?: string | string[]): string {
  const message = localeMessage("en", key, substitutions);
  if (message === key) throw new Error(`Missing en locale message: ${key}`);
  return message;
}

// The extension id off a running service worker, without waiting for one. Both
// callers wrap it in their own wait: the suite falls back to chrome://extensions,
// the plain-Node caller to a `serviceworker` event.
export function extensionIdFromServiceWorkers(context: BrowserContext): string | null {
  for (const worker of context.serviceWorkers()) {
    const match = worker.url().match(/^chrome-extension:\/\/([^/]+)\//);
    if (match?.[1]) return match[1];
  }
  return null;
}

// One URL builder for the extension's own pages, scheme-switched by engine:
// `chrome-extension://` normally, `moz-extension://` under E2E_BROWSER=firefox
// (where the id is the pinned UUID from lib/firefox-addon.ts). The env var is
// read inline because this module is a LEAF (see the header) - it cannot import
// isFirefoxRun from browser-session. Unset env (the plain-Node caller) keeps
// the chrome scheme, which is what that caller drives.
export function extensionPageUrl(extensionId: string, file: string): string {
  const scheme = process.env.E2E_BROWSER === "firefox" ? "moz-extension" : "chrome-extension";
  return `${scheme}://${extensionId}/${file}`;
}

function authPageUrl(extensionId: string): string {
  return extensionPageUrl(extensionId, "auth.html");
}

// A crashed/torn-down page: Playwright throws "Page crashed" (renderer OOM/crash)
// or "Target closed". Environmental, not a test assertion - callers reopen + retry.
// Shared with lib/reaction-surface.ts's openSite, which self-heals the same way.
export function isPageCrash(err: unknown): boolean {
  return err instanceof Error && /page crashed|target (page,? )?closed|crashed/i.test(err.message);
}

interface AuthSignInOptions {
  email: string;
  code: string;
  /** Matches a `--lang=<locale>` browser, so the auth page's button labels
   *  resolve to that language's shipped copy. */
  locale?: string;
  /** Runs on each freshly opened auth tab BEFORE its first navigation - the
   *  plain-Node caller pins the tab's color scheme there. */
  prepare?: (page: Page) => Promise<void>;
}

// Sign in by opening auth.html directly with the given test-account credentials.
// Takes an already-resolved extension id: the two callers reach it differently.
export async function signInThroughAuthPage(context: BrowserContext, extensionId: string, opts: AuthSignInOptions): Promise<void> {
  const locale = opts.locale ?? "en";
  const authUrl = authPageUrl(extensionId);
  let authPage = await context.newPage();
  try {
    await opts.prepare?.(authPage);
    await authPage.goto(authUrl);
    // Retry the whole request-code/verify exchange: a first verify
    // occasionally fails transiently, and a fresh exchange clears it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (await requestAndVerifyOtp(authPage, opts.email, opts.code, locale)) return;
        await authPage.waitForTimeout(1_500);
      } catch (err) {
        // A headed Chrome renderer occasionally crashes under full-suite load
        // ("Page crashed") - the auth tab is then dead and every op on it throws.
        // Reopen a fresh tab and retry rather than hard-failing on an
        // environmental blip; a genuinely stuck sign-in still fails the assert below.
        if (!isPageCrash(err)) throw err;
        await authPage.close().catch(() => {});
        authPage = await context.newPage();
        await opts.prepare?.(authPage);
        await authPage.goto(authUrl).catch(() => {});
      }
    }
    // Surface a genuinely stuck sign-in with the usual explicit assertion, and
    // carry the page's own error into the message: without it the failure reads
    // as a missing field and says nothing about WHY the exchange never got past
    // "Send code" (a full-suite run lost three tests to exactly that).
    const reported = await authPage
      .locator(".error")
      .first()
      .innerText()
      .catch(() => "");
    await expect(authPage.getByRole("heading", { name: localeMessage(locale, "authDoneTitle") }), reported ? `sign-in never completed - the auth page reported: ${reported}` : "sign-in never completed and the auth page showed no error").toBeVisible();
  } finally {
    await authPage.close().catch(() => {});
  }
}

// One request-code/verify pass. Returns true once "You're signed in" shows;
// false if the code was rejected (the caller re-runs the exchange).
// Structural failures - never reaching the code step, verify hanging - still throw.
async function requestAndVerifyOtp(authPage: Page, email: string, code: string, locale: string): Promise<boolean> {
  // Reset the "Send code" cooldown a prior sign-in left in this profile (the
  // restart test signs in twice on one profile, which otherwise leaves the button
  // disabled). The key is a literal because this module stays import-free (see the
  // header); it must equal OTP_COOLDOWN_KEY in src/entrypoints/auth/otp-cooldown.ts.
  await authPage.evaluate(() => {
    try {
      localStorage.removeItem("otp_cooldown_v1");
    } catch {
      /* storage unavailable */
    }
  });
  await authPage.reload();
  await expect(authPage.locator("#email-input")).toBeVisible();
  await authPage.locator("#email-input").fill(email);
  // The Terms/Privacy box ships unchecked, so consent is a required step of
  // every sign-in.
  await authPage.locator(".agree input[type=checkbox]").check();
  const sendBtn = authPage.getByRole("button", { name: localeMessage(locale, "authSendCodeBtn") });
  // Enabled once the email is valid + consent given + cooldown clear; wait out
  // any residual cooldown rather than clicking a disabled button.
  await expect(sendBtn).toBeEnabled({ timeout: 65_000 });
  await sendBtn.click();
  // The send itself can fail for reasons outside the extension - the backend
  // answering an error, the service worker missing the message (auth/main.tsx
  // renders authErrUnknown for both) - and the page then stays on the email step
  // with that error instead of the code field. Report it as a failed pass, like
  // the verify below, so the caller's retry loop runs a fresh exchange rather
  // than hard-failing on a field that was never going to appear.
  const codeInput = authPage.locator("#code-input");
  const sent = await expect(codeInput.or(authPage.locator(".error")))
    .toBeVisible({ timeout: 30_000 })
    .then(() => codeInput.isVisible())
    .catch(() => false);
  if (!sent) return false;
  await authPage.locator("#code-input").fill(code);
  await authPage.getByRole("button", { name: localeMessage(locale, "authVerifyBtn") }).click();
  const signedIn = authPage.getByRole("heading", { name: localeMessage(locale, "authDoneTitle") });
  // Wait for the verify to resolve either way - the success heading or the inline
  // error. A verify request can also die at the network layer and change NOTHING
  // on the page (seen live) - report that as a failed pass so the
  // caller's retry loop reloads and runs a fresh exchange instead of throwing.
  const resolved = await expect(signedIn.or(authPage.locator(".error")))
    .toBeVisible({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  if (!resolved) return false;
  return signedIn.isVisible();
}
