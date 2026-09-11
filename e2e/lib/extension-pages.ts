// SPDX-License-Identifier: GPL-3.0-or-later
//
// The extension's OWN surfaces: resolving its id, opening the popup, and driving
// the Account tab to a known auth state. Everything here talks to
// `chrome-extension://<id>/...` pages - never a site page, which is
// reaction-surface.ts's half.
//
// The OTP exchange itself is `auth-signin.ts`, a leaf plain Node can also load;
// this module only supplies the id.
import { type BrowserContext, expect, type Page, type Worker } from "@playwright/test";
import { extensionIdFromServiceWorkers, extensionPageUrl, localeMessage, signInThroughAuthPage } from "./auth-signin";
import { isFirefoxRun } from "./browser-session";
import { FIREFOX_EXTENSION_UUID } from "./firefox-addon";
import { firefoxBridge } from "./firefox-bridge";
import { DEEP_QUERY_ALL_SRC } from "./probe-src";
import { authCode, authEmail } from "./test-config";

// The background worker - the one context that can write extension storage. It
// starts with the first extension page/content script, so callers open a tab first.
// CHROMIUM-ONLY: on the firefox run the background is an MV2 page reached over
// the debugger protocol instead - go through evalInBackground, which branches.
export async function firstServiceWorker(context: BrowserContext): Promise<Worker> {
  if (isFirefoxRun()) throw new Error("firstServiceWorker is chromium-only - use evalInBackground, which reaches Firefox's background page through firefox-bridge.ts");
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
}

// Run `fn(arg)` in the extension's background context on either engine. The body
// travels as source, so it must be self-contained, and it reaches the API as
// `(globalThis.browser ?? chrome)`: Firefox's `chrome.*` returns no promises.
export async function evalInBackground<T, A = undefined>(context: BrowserContext, fn: (arg: A) => T | Promise<T>, arg?: A): Promise<T> {
  if (isFirefoxRun()) return (await firefoxBridge(context)).evalInBackground(fn, arg);
  const worker = await firstServiceWorker(context);
  const evaluate = worker.evaluate.bind(worker) as (pageFunction: unknown, arg: unknown) => Promise<unknown>;
  return (await evaluate(fn, arg)) as T;
}

// The stored auth session, read where it lives: `auth_v1` in local storage
// (src/shared/auth-session.ts AUTH_KEY - a literal so this stays a leaf module).
const AUTH_STORAGE_KEY = "auth_v1";

function hasStoredAuthSession(context: BrowserContext): Promise<boolean> {
  return evalInBackground(
    context,
    async (key) => {
      const api = (globalThis as { browser?: typeof browser }).browser ?? (chrome as unknown as typeof browser);
      const stored = await api.storage.local.get(key);
      return Boolean(stored[key]);
    },
    AUTH_STORAGE_KEY,
  );
}

type OtpAnswer = { ok?: boolean; status?: number; error?: string } | undefined;

// The OTP exchange auth.html performs, sent from a popup tab the bridge opened:
// the same two extension-page-only runtime messages, minus the form. Retried
// like signInThroughAuthPage, since a first verify occasionally fails transiently.
async function signInOverBridge(context: BrowserContext, email: string, code: string): Promise<void> {
  const tab = await (await firefoxBridge(context)).openExtensionTab("popup.html");
  try {
    let lastAnswer = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const requested = await tab.evaluate((email) => browser.runtime.sendMessage({ type: "auth:requestOtp", email }) as Promise<OtpAnswer>, email);
      if (requested?.ok) {
        const verified = await tab.evaluate(({ email, code }) => browser.runtime.sendMessage({ type: "auth:verifyOtp", email, code }) as Promise<OtpAnswer>, { email, code });
        if (verified?.ok) return;
        lastAnswer = JSON.stringify(verified ?? null);
      } else {
        lastAnswer = JSON.stringify(requested ?? null);
      }
      await new Promise((settle) => setTimeout(settle, 1_500));
    }
    throw new Error(`sign-in over the Firefox bridge never completed - the background answered: ${lastAnswer}`);
  } finally {
    await tab.close();
  }
}

export async function resolveExtensionId(context: BrowserContext): Promise<string | null> {
  // Firefox: the moz-extension "id" is the internal UUID, pinned at launch by
  // pref - the install is part of the launch, so no waiting is involved.
  if (isFirefoxRun()) return FIREFOX_EXTENSION_UUID;
  const existing = extensionIdFromServiceWorkers(context);
  if (existing) return existing;
  const fromWorker = await context
    .waitForEvent("serviceworker", { timeout: 5_000 })
    .then(() => extensionIdFromServiceWorkers(context))
    .catch(() => null);
  if (fromWorker) return fromWorker;
  return await extensionIdFromExtensionsPage(context).catch(() => null);
}

async function extensionIdFromExtensionsPage(context: BrowserContext): Promise<string | null> {
  const page = await context.newPage();
  try {
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
    // chrome://extensions renders its item cards asynchronously after DOMContentLoaded.
    await page.waitForTimeout(1_000);
    return await page.evaluate<string | null>(`(() => {
      ${DEEP_QUERY_ALL_SRC}
      for (const item of deepQueryAll("extensions-item")) {
        const text = (item.textContent ?? "") + " " + (item.shadowRoot?.textContent ?? "");
        if (!text.includes("Emojery")) continue;
        const id = item.getAttribute("id") || item.getAttribute("extension-id") || item.id;
        if (id) return id;
      }
      return null;
    })()`);
  } finally {
    await page.close().catch(() => {});
  }
}

// Fail loud instead of a 60s goto timeout - see isFirefoxRun's note in
// browser-session.ts for why extension pages are unreachable there.
function requireExtensionPageAccess(what: string): void {
  if (isFirefoxRun()) throw new Error(`${what} needs an extension page, which Playwright Firefox cannot reach - guard the spec with test.skip(isFirefoxRun(), ...)`);
}

export async function openPopup(context: BrowserContext): Promise<Page> {
  requireExtensionPageAccess("openPopup");
  const extensionId = await resolveExtensionId(context);
  expect(extensionId, "Emojery must be loaded before opening the popup").not.toBeNull();
  if (!extensionId) throw new Error("Missing Emojery extension id");
  const popup = await context.newPage();
  await popup.goto(extensionPageUrl(extensionId, "popup.html"));
  await expect(popup.getByRole("heading", { name: "Emojery" })).toBeVisible();
  return popup;
}

// Sign in by opening auth.html directly. Defaults to the primary test account;
// `locale` as documented on auth-signin.ts's AuthSignInOptions. The exchange
// itself lives in `auth-signin.ts`.
export async function signIn(context: BrowserContext, email: string = authEmail(), code: string = authCode(email), locale = "en"): Promise<void> {
  if (isFirefoxRun()) return signInOverBridge(context, email, code);
  const extensionId = await resolveExtensionId(context);
  expect(extensionId, "Emojery must be loaded before signing in").not.toBeNull();
  if (!extensionId) throw new Error("Missing Emojery extension id");
  await signInThroughAuthPage(context, extensionId, { email, code, locale });
}

type AccountState = "signed-in" | "signed-out" | "loading";

async function accountState(popup: Page, locale = "en"): Promise<AccountState> {
  await popup.getByRole("tab", { name: localeMessage(locale, "tabAccount") }).click();
  const signIn = popup.getByRole("button", { name: localeMessage(locale, "signInBtn") });
  const signOut = popup.getByRole("button", { name: localeMessage(locale, "signOutBtn") });
  if (await signIn.isVisible().catch(() => false)) return "signed-out";
  if (await signOut.isVisible().catch(() => false)) return "signed-in";
  return "loading";
}

export async function isSignedIn(context: BrowserContext): Promise<boolean> {
  if (isFirefoxRun()) return hasStoredAuthSession(context);
  const popup = await openPopup(context);
  try {
    await expect
      .poll(() => accountState(popup), {
        message: "Account tab should resolve auth state",
      })
      .not.toBe("loading");
    return (await accountState(popup)) === "signed-in";
  } finally {
    await popup.close().catch(() => {});
  }
}

// Idempotent: drives the popup Account tab to a signed-out state. `locale` as
// documented on auth-signin.ts's AuthSignInOptions. The sign-out wait falls
// back to reloading the popup when NEITHER button renders: a popup opened
// mid-sign-out can stall buttonless until a fresh load.
export async function ensureSignedOut(context: BrowserContext, locale = "en"): Promise<void> {
  if (isFirefoxRun()) return ensureSignedOutOverBridge(context);
  const popup = await openPopup(context);
  try {
    await expect.poll(() => accountState(popup, locale), { message: "Account tab should show auth state" }).not.toBe("loading");
    if ((await accountState(popup, locale)) === "signed-out") return;
    await popup.getByRole("button", { name: localeMessage(locale, "signOutBtn") }).click();
    await expect
      .poll(
        async () => {
          const state = await accountState(popup, locale);
          if (state !== "loading") return state;
          await popup.reload();
          await expect(popup.getByRole("heading", { name: "Emojery" })).toBeVisible();
          return accountState(popup, locale);
        },
        { message: "extension auth state should be signed out" },
      )
      .toBe("signed-out");
  } finally {
    await popup.close().catch(() => {});
  }
}

// The popup's Sign out, as the runtime message it sends; settled once the stored
// session is gone, which is what the content scripts key their state on.
async function ensureSignedOutOverBridge(context: BrowserContext): Promise<void> {
  if (!(await hasStoredAuthSession(context))) return;
  const tab = await (await firefoxBridge(context)).openExtensionTab("popup.html");
  try {
    await tab.evaluate(() => browser.runtime.sendMessage({ type: "auth:signOut" }).then(() => undefined));
    await expect.poll(() => hasStoredAuthSession(context), { message: "extension auth state should be signed out" }).toBe(false);
  } finally {
    await tab.close();
  }
}
