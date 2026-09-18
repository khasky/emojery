// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { identityWindowAfter, revealTestProvider, TEST_PROVIDER } from "./lib/auth-signin";
import { authAccount, authConfigured, closeSession, completeSignIn, enMessage, extensionPageUrl, FIREFOX_NO_EXTENSION_PAGES, isFirefoxRun, launchSession, localeMessage, removeProfileUnlessKept, resolveExtensionId, resolveExtensionPath, signInSkipReason } from "./lib/extension";
import { AGREE_CHECKBOX_SELECTOR, PROVIDER_BUTTON_SELECTOR, providerButtonSelector } from "./lib/selectors";

// Whole file drives auth.html/popup.html, which Playwright Firefox cannot reach.
test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);

// No hardcoded origin fallback, the rule requiredEnvUrl in lib/test-config.ts states: an unset
// key must fail naming the key. A production default checked a STAGING build against the
// production origin and threw "manifest is missing host permission", sending the reader to
// rebuild instead of to the env file. Resolved in beforeAll, past the not-configured skip.
function requireAuthApiBase(): string {
  const value = (process.env.E2E_API_BASE ?? process.env.WXT_API_BASE ?? "").trim();
  if (!value) {
    throw new Error("Set E2E_API_BASE (or WXT_API_BASE) in .env.e2e.example (the checked-in defaults) or override it in .env.e2e / .env.e2e.local - it is the origin the build under test talks to.");
  }
  new URL(value);
  return value;
}

let authApiBase: string;
// Resolved in beforeAll, behind the sign-in gate: the resolver throws when unset.
let testAccount: string;
const localizedAuthLocales = ["ru", "de", "ja"] as const;

// The auth page is a narrow card; shooting it at the suite default would frame mostly
// empty background.
const AUTH_VIEWPORT = { width: 1024, height: 768 };

let context: BrowserContext;
let generatedUserDataDir: string | null = null;
let extensionId: string;

test.describe("extension account auth", () => {
  test.skip(!authConfigured(), signInSkipReason("the auth e2e test"));

  test.beforeAll(async () => {
    const extensionPath = resolveExtensionPath();
    authApiBase = requireAuthApiBase();
    testAccount = authAccount();
    assertExtensionManifestAllowsApiBase(extensionPath, authApiBase);
    await assertApiReachable(authApiBase);

    const session = await launchAuthBrowserSession();
    context = session.context;
    generatedUserDataDir = session.generatedUserDataDir;

    const loadedExtensionId = await resolveExtensionId(context);
    expect(loadedExtensionId, "Emojery must be loaded as an unpacked extension before auth checks run").not.toBeNull();
    extensionId = loadedExtensionId!;
  });

  test.afterAll(async () => {
    await context?.close();
    if (generatedUserDataDir) await removeProfileUnlessKept(generatedUserDataDir);
  });

  test("signs in from popup account tab through the test provider and signs out again", async () => {
    const popup = await openPopupPage();
    await popup.getByRole("tab", { name: enMessage("tabAccount") }).click();
    await expect(popup.getByText(enMessage("signInMsgAccount"))).toBeVisible();

    const authPagePromise = context.waitForEvent("page");
    await popup.getByRole("button", { name: enMessage("signInBtn") }).click();
    const authPage = await authPagePromise;
    await authPage.waitForURL(extensionPageUrl(extensionId, "auth.html"));

    // The provider list is the API's: the staging build lists the test provider
    // beside the real ones, and every button waits for the consent box.
    const agreeCheckbox = authPage.locator(AGREE_CHECKBOX_SELECTOR);
    await expect(agreeCheckbox).not.toBeChecked();
    for (const button of await authPage.locator(PROVIDER_BUTTON_SELECTOR).all()) await expect(button).toBeDisabled();
    await agreeCheckbox.check();
    await revealTestProvider(authPage);
    const testButton = authPage.locator(providerButtonSelector(TEST_PROVIDER));
    await expect(testButton).toBeVisible();
    await expect(testButton).toHaveText(enMessage("authProviderBtn", TEST_PROVIDER));
    await expect(testButton).toBeEnabled();

    // Closing the identity window before the provider answers is the cancelled
    // refusal: the page says so and hands the list back, consent kept.
    const windowToCancel = await identityWindowAfter(authPage, () => testButton.click());
    expect(windowToCancel, "the identity window should open on the first click").not.toBeNull();
    await windowToCancel!.close();
    await expect(authPage.getByText(enMessage("authErrCancelled"), { exact: true })).toBeVisible();
    await expect(agreeCheckbox).toBeChecked();
    await expect(testButton).toBeEnabled();

    // A sign-in the provider refuses: the auth page reports the provider's
    // refusal rather than signing in.
    const windowToRefuse = await identityWindowAfter(authPage, () => testButton.click());
    expect(windowToRefuse, "the identity window should open on the second click").not.toBeNull();
    await completeSignIn(windowToRefuse!, testAccount, "refused");
    await expect(authPage.getByText(enMessage("authErrProviderDenied"), { exact: true })).toBeVisible();
    await expect(authPage.getByRole("heading", { name: enMessage("authDoneTitle") })).toHaveCount(0);

    const windowToAccept = await identityWindowAfter(authPage, () => testButton.click());
    expect(windowToAccept, "the identity window should open on the third click").not.toBeNull();
    await completeSignIn(windowToAccept!, testAccount);
    // A first sign-in enrolls the account before the window comes back (measured on
    // staging: 14-23 s, more when the prover starts cold); the default wait is too
    // short for it.
    await expect(authPage.getByRole("heading", { name: enMessage("authDoneTitle") })).toBeVisible({ timeout: 60_000 });

    await authPage.close();
    await popup.close();

    const signedInPopup = await openPopupPage();
    await signedInPopup.getByRole("tab", { name: enMessage("tabAccount") }).click();
    await expect(signedInPopup.getByText(enMessage("signedInLabel"), { exact: true })).toBeVisible();
    // The account is named by its provider, never by anything the provider knows.
    await expect(signedInPopup.getByText(enMessage("signedInVia", TEST_PROVIDER), { exact: true })).toBeVisible();
    await expect(signedInPopup.getByText(testAccount)).toHaveCount(0);

    await signedInPopup.getByRole("button", { name: enMessage("signOutBtn") }).click();
    await expect(signedInPopup.getByText(enMessage("signInMsgAccount"))).toBeVisible();
    await expect(signedInPopup.getByRole("button", { name: enMessage("signInBtn") })).toBeVisible();
    await expect(signedInPopup.getByText(enMessage("signedInVia", TEST_PROVIDER), { exact: true })).toHaveCount(0);

    await signedInPopup.close();
  });

  for (const locale of localizedAuthLocales) {
    test(`auth.html localizes the provider step and its refusal with --lang=${locale}`, async () => {
      const session = await launchAuthBrowserSession({
        locale,
        useGeneratedUserDataDir: true,
      });
      const localizedExtensionId = await resolveExtensionId(session.context);
      expect(localizedExtensionId, `Emojery must be loaded before localized auth checks run in ${locale}`).not.toBeNull();
      if (!localizedExtensionId) {
        await closeSession(session);
        return;
      }

      const authPage = await session.context.newPage();
      try {
        await authPage.goto(extensionPageUrl(localizedExtensionId, "auth.html"));
        await expect(
          authPage.getByRole("heading", {
            name: localeMessage(locale, "authSignInTitle"),
          }),
        ).toBeVisible();
        await authPage.locator(AGREE_CHECKBOX_SELECTOR).check();
        await revealTestProvider(authPage);
        const testButton = authPage.locator(providerButtonSelector(TEST_PROVIDER));
        await expect(testButton).toHaveText(localeMessage(locale, "authProviderBtn", TEST_PROVIDER));
        await expect(testButton).toBeEnabled();

        const window = await identityWindowAfter(authPage, () => testButton.click());
        await expect(authPage.getByText(localeMessage(locale, "authSigningInWith", TEST_PROVIDER), { exact: true })).toBeVisible();
        expect(window, `the identity window should open in ${locale}`).not.toBeNull();
        await window!.close();
        await expect(
          authPage.getByText(localeMessage(locale, "authErrCancelled"), {
            exact: true,
          }),
        ).toBeVisible();
      } finally {
        await authPage.close().catch(() => {});
        await closeSession(session);
      }
    });
  }
});

interface AuthBrowserSession {
  context: BrowserContext;
  generatedUserDataDir: string | null;
}

interface LaunchAuthBrowserOptions {
  locale?: string;
  useGeneratedUserDataDir?: boolean;
}

// The shared launcher at this file's own window size. `useGeneratedUserDataDir` drops
// E2E_USER_DATA_DIR for that launch: the localized legs need a profile with no session
// in it, whatever the runner points the shared one at.
async function launchAuthBrowserSession(options: LaunchAuthBrowserOptions = {}): Promise<AuthBrowserSession> {
  const explicitDir = options.useGeneratedUserDataDir ? undefined : process.env.E2E_USER_DATA_DIR;
  return launchSession({
    viewport: AUTH_VIEWPORT,
    ...(explicitDir ? { userDataDir: explicitDir } : {}),
    ...(options.locale ? { locale: options.locale } : {}),
  });
}

async function openPopupPage(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(extensionPageUrl(extensionId, "popup.html"));
  await expect(page.getByRole("heading", { name: enMessage("popupHeading") })).toBeVisible();
  return page;
}

function assertExtensionManifestAllowsApiBase(extensionPath: string, apiBase: string): void {
  const expected = hostPermissionForApiBase(apiBase);
  const manifestPath = resolve(extensionPath, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    host_permissions?: string[];
  };
  if (!manifest.host_permissions?.includes(expected)) {
    throw new Error(`Built extension manifest is missing host permission ${expected}. ` + `Rebuild with "pnpm run build:chrome" (or WXT_API_BASE=${apiBase}).`);
  }
}

function hostPermissionForApiBase(apiBase: string): string {
  return `${new URL(apiBase).origin}/*`;
}

// Probes the same public read endpoint the extension uses; any response below 500 proves the API is up.
async function assertApiReachable(apiBase: string): Promise<void> {
  const probeUrl = new URL("/reactions/count", apiBase);
  const res = await fetch(probeUrl);
  if (res.status >= 500) {
    throw new Error(`Auth e2e API is not reachable at ${probeUrl}: ${res.status}`);
  }
}
