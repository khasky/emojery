// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { authCode, authConfigured, authEmail, closeSession, enMessage, extensionPageUrl, FIREFOX_NO_EXTENSION_PAGES, isFirefoxRun, launchSession, localeMessage, otpSkipReason, removeProfileUnlessKept, resolveExtensionId, resolveExtensionPath, wrongCodeFor } from "./lib/extension";
import { AGREE_CHECKBOX_SELECTOR, CODE_INPUT_SELECTOR, EMAIL_INPUT_SELECTOR } from "./lib/selectors";

// Whole file drives auth.html/popup.html, which Playwright Firefox cannot reach.
test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);

// No hardcoded origin fallback, the rule lib/test-config.ts's requiredEnvUrl states: an unset
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

// The fixture for the rejection error path: an address the auth page ends up
// showing its refusal message for. Unset fails naming the key, like
// requireAuthApiBase above.
function requireRejectedEmail(): string {
  const value = (process.env.E2E_REJECTED_EMAIL ?? "").trim();
  if (!value) {
    throw new Error("Set E2E_REJECTED_EMAIL in .env.e2e.example (the checked-in defaults) or override it in .env.e2e / .env.e2e.local - the address the rejection error-path checks sign in with.");
  }
  return value;
}

let authApiBase: string;
let rejectedEmail: string;
const testEmail = authEmail();
const localizedAuthErrorLocales = ["ru", "de", "ja"] as const;

// The auth page is a narrow card; shooting it at the suite default would frame mostly
// empty background.
const AUTH_VIEWPORT = { width: 1024, height: 768 };

let context: BrowserContext;
let generatedUserDataDir: string | null = null;
let extensionId: string;

test.describe("extension account auth", () => {
  test.skip(!authConfigured(), otpSkipReason("the auth e2e test"));

  test.beforeAll(async () => {
    const extensionPath = resolveExtensionPath();
    authApiBase = requireAuthApiBase();
    rejectedEmail = requireRejectedEmail();
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

  test("signs in from popup account tab and signs out again", async () => {
    const popup = await openPopupPage();
    await popup.getByRole("tab", { name: enMessage("tabAccount") }).click();
    await expect(popup.getByText(enMessage("signInMsgAccount"))).toBeVisible();

    const authPagePromise = context.waitForEvent("page");
    await popup.getByRole("button", { name: enMessage("signInBtn") }).click();
    const authPage = await authPagePromise;
    await authPage.waitForURL(extensionPageUrl(extensionId, "auth.html"));

    await expect(authPage.locator(EMAIL_INPUT_SELECTOR)).toBeVisible();
    const emailInput = authPage.locator(EMAIL_INPUT_SELECTOR);
    const sendCodeButton = authPage.getByRole("button", { name: enMessage("authSendCodeBtn") });

    await expect(sendCodeButton).toBeDisabled();
    await emailInput.fill("not-an-email");
    await expect(sendCodeButton).toBeDisabled();
    await expect(authPage.locator(CODE_INPUT_SELECTOR)).toHaveCount(0);

    // Consent is opt-in: a valid address alone must not enable the send.
    const agreeCheckbox = authPage.locator(AGREE_CHECKBOX_SELECTOR);
    await emailInput.fill(rejectedEmail);
    await expect(agreeCheckbox).not.toBeChecked();
    await expect(sendCodeButton).toBeDisabled();
    await agreeCheckbox.check();
    await expect(sendCodeButton).toBeEnabled();
    await sendCodeButton.click();
    await expect(
      authPage.getByText(localeMessage("en", "authErrEmailDomainUndeliverable"), {
        exact: true,
      }),
    ).toBeVisible();
    await expect(authPage.locator(CODE_INPUT_SELECTOR)).toHaveCount(0);

    await emailInput.fill(testEmail);
    await expect(sendCodeButton).toBeEnabled();
    await sendCodeButton.click();

    const codeInput = authPage.locator(CODE_INPUT_SELECTOR);
    const signInButton = authPage.getByRole("button", { name: enMessage("authVerifyBtn") });
    await expect(codeInput).toBeVisible();
    await expect(signInButton).toBeDisabled();
    await expect(authPage.getByRole("button", { name: /Resend code in \d+:\d{2}/ })).toBeDisabled();

    await authPage.getByRole("button", { name: enMessage("authUseDifferentEmail") }).click();
    // The cooldown text renders twice: the visible ticking line plus an sr-only
    // one-shot live-region copy - assert on the visible (aria-hidden) one.
    await expect(authPage.getByText(/We already sent a code to this address\./).and(authPage.locator('[aria-hidden="true"]'))).toBeVisible();
    await authPage.getByRole("button", { name: enMessage("authEnterPendingCode", testEmail) }).click();
    await expect(codeInput).toBeVisible();

    await codeInput.fill(wrongCodeFor(authCode(testEmail)));
    await expect(signInButton).toBeEnabled();
    await signInButton.click();
    await expect(
      authPage.getByText(localeMessage("en", "authErrCodeInvalid"), {
        exact: true,
      }),
    ).toBeVisible();

    await codeInput.fill(authCode(testEmail));
    await signInButton.click();
    await expect(authPage.getByRole("heading", { name: enMessage("authDoneTitle") })).toBeVisible();

    await authPage.close();
    await popup.close();

    const signedInPopup = await openPopupPage();
    await signedInPopup.getByRole("tab", { name: enMessage("tabAccount") }).click();
    await expect(signedInPopup.getByText(enMessage("signedInLabel"), { exact: true })).toBeVisible();
    await expect(signedInPopup.getByText(testEmail, { exact: true })).toBeVisible();

    await signedInPopup.getByRole("button", { name: enMessage("signOutBtn") }).click();
    await expect(signedInPopup.getByText(enMessage("signInMsgAccount"))).toBeVisible();
    await expect(signedInPopup.getByRole("button", { name: enMessage("signInBtn") })).toBeVisible();
    await expect(signedInPopup.getByText(testEmail, { exact: true })).toHaveCount(0);

    await signedInPopup.close();
  });

  for (const locale of localizedAuthErrorLocales) {
    test(`auth.html localizes visible errors with --lang=${locale}`, async () => {
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
        await authPage.locator(EMAIL_INPUT_SELECTOR).fill(rejectedEmail);
        await authPage.locator(AGREE_CHECKBOX_SELECTOR).check();
        const sendCodeButton = authPage.getByRole("button", {
          name: localeMessage(locale, "authSendCodeBtn"),
        });
        await expect(sendCodeButton).toBeEnabled();
        await sendCodeButton.click();
        await expect(
          authPage.getByText(localeMessage(locale, "authErrEmailDomainUndeliverable"), {
            exact: true,
          }),
        ).toBeVisible();

        await authPage.locator(EMAIL_INPUT_SELECTOR).fill(testEmail);
        await expect(sendCodeButton).toBeEnabled();
        await sendCodeButton.click();

        const codeInput = authPage.locator(CODE_INPUT_SELECTOR);
        const signInButton = authPage.getByRole("button", {
          name: localeMessage(locale, "authVerifyBtn"),
        });
        await expect(codeInput).toBeVisible();
        await codeInput.fill(wrongCodeFor(authCode(testEmail)));
        await expect(signInButton).toBeEnabled();
        await signInButton.click();
        await expect(
          authPage.getByText(localeMessage(locale, "authErrCodeInvalid"), {
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
    throw new Error(`Built extension manifest is missing host permission ${expected}. ` + `Rebuild with "pnpm run build:staging" (or WXT_API_BASE=${apiBase}).`);
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
