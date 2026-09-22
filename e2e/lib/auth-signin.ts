// SPDX-License-Identifier: GPL-3.0-or-later
//
// Driving the extension's OWN auth page (auth.html) through the test provider: the
// page's selectors, its shipped button labels, and the provider
// sign-in that runs through the browser's identity window, with the retries that
// make it survive a real backend. What happens INSIDE that window is the caller's
// `completeSignIn` (the out-of-tree sign-in resolver, see lib/test-config.ts).
//
// A LEAF module: it is also loaded directly under plain Node, where types are
// stripped at load and imports resolve by Node's own rules. So: nothing outside
// `node:*`, `@playwright/test` and `./selectors` - which is itself only string
// constants re-exported from the extension, with no runtime of its own. Keep the
// export shape stable, and do not reach for anything that runs code at import.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { AGREE_CHECKBOX_SELECTOR, AUTH_ERROR_SELECTOR, MORE_PROVIDERS_SELECTOR, PROVIDER_LIST_SELECTOR, providerButtonSelector } from "./selectors";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const EXTENSION_ROOT = resolve(__dirname, "..", "..");

// The provider the suites sign in with. Offered only by non-production builds; which
// backend a run talks to is E2E_API_BASE's business, not this module's.
export const TEST_PROVIDER = "test";

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
// Shared with openSite in lib/reaction-surface.ts, which self-heals the same way.
export function isPageCrash(err: unknown): boolean {
  return err instanceof Error && /page crashed|target (page,? )?closed|crashed/i.test(err.message);
}

interface AuthSignInOptions {
  /** Completes the sign-in inside the identity window the provider button opened. */
  completeSignIn: (window: Page) => Promise<void>;
  /** Matches a `--lang=<locale>` browser, so the auth page's button labels
   *  resolve to that language's shipped copy. */
  locale?: string;
  /** Runs on each freshly opened auth tab BEFORE its first navigation - the
   *  plain-Node caller pins the tab's color scheme there. */
  prepare?: (page: Page) => Promise<void>;
}

// Sign in by opening auth.html directly with the given sign-in fixtures.
// Takes an already-resolved extension id: the two callers reach it differently.
export async function signInThroughAuthPage(context: BrowserContext, extensionId: string, opts: AuthSignInOptions): Promise<void> {
  const locale = opts.locale ?? "en";
  const authUrl = authPageUrl(extensionId);
  let authPage = await context.newPage();
  try {
    await opts.prepare?.(authPage);
    await authPage.goto(authUrl);
    // Retry the whole sign-in: a first pass occasionally fails transiently
    // (the identity window closing early, a slow provider), and a fresh one clears it.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (await signInThroughTestProvider(authPage, opts, locale)) return;
        // Backoff between passes: a failed one leaves the page with its refusal
        // shown; the next attempt reloads into a fresh pass regardless.
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
    // as a missing heading and says nothing about WHY the sign-in never got past
    // the provider button.
    const reported = await authPage
      .locator(AUTH_ERROR_SELECTOR)
      .first()
      .innerText()
      .catch(() => "");
    await expect(authPage.getByRole("heading", { name: localeMessage(locale, "authDoneTitle") }), reported ? `sign-in never completed - the auth page reported: ${reported}` : "sign-in never completed and the auth page showed no error").toBeVisible();
  } finally {
    await authPage.close().catch(() => {});
  }
}

/** The same sign-in against an auth tab the CALLER owns - the one a page's
 *  sign-in gate opened, which is the tab the return-to-page path closes by
 *  itself. Retries like signInThroughAuthPage, minus the reopen: this tab is the
 *  subject of the test, so losing it is a failure rather than a blip. */
export async function signInOnAuthPage(authPage: Page, opts: AuthSignInOptions): Promise<void> {
  const locale = opts.locale ?? "en";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (await signInThroughTestProvider(authPage, opts, locale)) return;
    // The same backoff signInThroughAuthPage's loop takes.
    await authPage.waitForTimeout(1_500);
  }
  await expect(authPage.getByRole("heading", { name: localeMessage(locale, "authDoneTitle") }), "sign-in never completed in the gate's own auth tab").toBeVisible();
}

// The page a click opens, found by its URL rather than by being the next one.
//
// "The next page event" is not the same thing: a fresh profile fires
// onInstalled("install"), the service worker opens onboarding.html into the spec's
// tab set, and lib/browser-session.ts closes it again a moment later. The service
// worker starts lazily - typically when the spec opens the popup - so that tab lands
// somewhere inside the very window a spec waits in, and a wait for "the next page"
// hands back a tab that is already closing. Matching the URL makes the race
// irrelevant. Null when nothing matches within the timeout.
//
// A page is checked when it opens and again on every main-frame navigation, because
// a tab is created before its URL commits. Only pages that open from here on count:
// the caller registers before the click that opens the one it wants, and matching an
// already-open tab would hand back whatever site page the spec left behind.
export function pageMatching(context: BrowserContext, matches: (url: string) => boolean, timeoutMs = 30_000): Promise<Page | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (page: Page | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.off("page", watch);
      resolve(page);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    const watch = (page: Page) => {
      if (matches(page.url())) return done(page);
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame() && matches(frame.url())) done(page);
      });
    };
    context.on("page", watch);
  });
}

// The identity window is a browser window of its own (identity.launchWebAuthFlow),
// carrying the provider's authorize URL - the only page in this flow that is not an
// extension page of ours. Registered BEFORE the click so a window that opens at once
// is not missed; null when none opens within the timeout.
export function identityWindowAfter(authPage: Page, open: () => Promise<void>): Promise<Page | null> {
  const opened = pageMatching(authPage.context(), (url) => url.startsWith("http"));
  return open().then(() => opened);
}

// The page opens with the featured providers only; the test provider sits behind
// "more sign-in options", which is gated by the same consent box, so this runs after
// the box is ticked. A build that lists nothing extra has no button.
export async function revealTestProvider(authPage: Page): Promise<void> {
  await expect(authPage.locator(PROVIDER_LIST_SELECTOR), "the auth page should list the providers the API offers").toBeVisible({ timeout: 30_000 });
  if (await authPage.locator(providerButtonSelector(TEST_PROVIDER)).isVisible()) return;
  await authPage.locator(MORE_PROVIDERS_SELECTOR).click();
}

// One sign-in pass. Returns true once "You're signed in" shows; false if the
// page reported a refusal (the caller re-runs the pass). Structural failures -
// never reaching the provider list, the identity window never opening - still throw.
async function signInThroughTestProvider(authPage: Page, opts: AuthSignInOptions, locale: string): Promise<boolean> {
  await authPage.reload();
  // The Terms/Privacy box ships unchecked, so consent is a required step of
  // every sign-in, and every provider button stays disabled until it is ticked.
  await authPage.locator(AGREE_CHECKBOX_SELECTOR).check();
  await revealTestProvider(authPage);
  const providerButton = authPage.locator(providerButtonSelector(TEST_PROVIDER));
  await expect(providerButton, "this build should list the test provider").toBeVisible({ timeout: 30_000 });
  await expect(providerButton).toBeEnabled();

  const window = await identityWindowAfter(authPage, () => providerButton.click());
  if (!window) {
    // The window never opened, or opened somewhere Playwright does not report:
    // that is the page-level failure, and it carries the auth page's own refusal
    // if there is one.
    const reported = await authPage
      .locator(AUTH_ERROR_SELECTOR)
      .first()
      .innerText()
      .catch(() => "");
    throw new Error(`the identity window never appeared${reported ? ` - the auth page reported: ${reported}` : ""}`);
  }
  // The resolver drives the provider's own page, so when it fails the raw error is
  // about a selector or a closed target and says nothing about WHY the window went
  // away. The window's last URL does: a redirect back to the extension means the
  // provider already answered (and the form was never shown), anything else means it
  // died where it stood. Pair that with whatever the auth page is reporting and the
  // failure names its own cause instead of handing over a Playwright message.
  try {
    await opts.completeSignIn(window);
  } catch (cause) {
    const closed = window.isClosed();
    const reported = await authPage
      .locator(AUTH_ERROR_SELECTOR)
      .first()
      .innerText()
      .catch(() => "");
    const where = `the identity window ${closed ? "closed" : "was still open"} at ${window.url() || "an unknown URL"}`;
    throw new Error(`the provider sign-in could not be completed - ${where}${reported ? `; the auth page reported: ${reported}` : ""}`, { cause });
  }

  // The window closes itself once the API redirects it back; the auth page then
  // exchanges the code and lands on the done step, or shows its refusal. A first
  // sign-in registers the device's account key during the exchange, which the
  // API takes tens of seconds to do, so the wait spans that.
  const signedIn = authPage.getByRole("heading", { name: localeMessage(locale, "authDoneTitle") });
  const resolved = await expect(signedIn.or(authPage.locator(AUTH_ERROR_SELECTOR)))
    .toBeVisible({ timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  if (!resolved) return false;
  return signedIn.isVisible();
}
