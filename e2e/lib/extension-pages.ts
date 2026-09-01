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
import { DEEP_QUERY_ALL_SRC } from "./probe-src";
import { authEmail, authOtp } from "./test-config";

// The background worker - the one context that can write extension storage. It
// starts with the first extension page/content script, so callers open a tab first.
// CHROMIUM-ONLY: Playwright cannot reach Firefox's MV2 background page, so specs
// that need this skip under E2E_BROWSER=firefox.
export async function firstServiceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
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
export async function signIn(context: BrowserContext, email: string = authEmail(), code: string = authOtp(), locale = "en"): Promise<void> {
  requireExtensionPageAccess("signIn");
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
