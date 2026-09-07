// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every shipped locale, on the extension's own three pages: the translation is
// actually substituted, no message key leaks through as raw text, and nothing
// overruns the popup's real width. `verify:locales` already checks the
// placeholder definitions in the catalogs and `i18n-locales.test.ts` the
// translation backlog - neither loads the pages, so a string that fits the
// catalog but not the layout only shows up here.
//
// a11y.spec.ts owns the reflow breakpoint for auth/onboarding, in ONE language.
// This file is the other axis: the same popup at its real width, in all of them.
//
// Browser-local: no network, no account. Retries are off for that reason - an
// intermittent failure here is a product bug, not a live-surface blip.
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import * as ext from "./lib/extension";

// The narrowest the popup ever paints: `min-width: 360px` in popup.css, which is
// also what Chrome gives the real popup. Long translations break here or nowhere.
const POPUP_VIEWPORT = { width: 360, height: 600 };

const LOCALES_DIR = resolve(ext.EXTENSION_ROOT, "public", "_locales");

interface MessageCatalog {
  [key: string]: { message: string } | undefined;
}

function catalog(locale: string): MessageCatalog {
  return JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, "messages.json"), "utf8")) as MessageCatalog;
}

const EN = catalog("en");
// Chrome's own fallback: an untranslated key renders the English message, so that
// is what the assertions expect for a locale with a backlog.
function messageFor(locale: MessageCatalog, key: string): string {
  const message = locale[key]?.message ?? EN[key]?.message;
  if (!message) throw new Error(`Unknown message key: ${key}`);
  return message;
}

// `_locales` uses Chrome's underscore form (pt_BR); --lang wants the BCP-47 tag.
function langTag(localeDir: string): string {
  return localeDir.replace("_", "-");
}

function sweptLocales(): string[] {
  const shipped = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  // A subset for a targeted rerun: E2E_LOCALES=de,ru. Unknown names fail loudly
  // rather than silently sweeping nothing.
  const requested = (process.env.E2E_LOCALES ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of requested) {
    if (!shipped.includes(name)) throw new Error(`E2E_LOCALES names ${name}, which is not in public/_locales`);
  }
  return requested.length > 0 ? requested : shipped;
}

// Every message key as a word: if one reaches the screen, i18n did not resolve it.
const RAW_KEY_PATTERN = new RegExp(`\\b(${Object.keys(EN).join("|")})\\b`);

async function expectNoRawMessageKeys(page: Page, surface: string): Promise<void> {
  const text = await page.locator("body").innerText();
  const leaked = text.match(RAW_KEY_PATTERN);
  expect(leaked?.[0] ?? null, `${surface}: a raw message key reached the screen`).toBeNull();
}

// Two different failures: the page scrolling sideways (a wide element pushing the
// layout out) and a control that hangs past the viewport while the page does not
// scroll (clipped by an overflow container). Both read as "cut off" to a user.
async function expectFitsPopupWidth(page: Page, surface: string): Promise<void> {
  const fit = await page.evaluate(() => {
    const doc = document.documentElement;
    const escaped: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>("button, input, select, a"))) {
      if (el.closest(".sr-only")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.right > doc.clientWidth + 1 || rect.left < -1) {
        escaped.push(`${el.tagName.toLowerCase()}.${el.className} [${Math.round(rect.left)}..${Math.round(rect.right)}] of ${doc.clientWidth}`);
      }
    }
    return { sidewaysScroll: doc.scrollWidth - doc.clientWidth, escaped };
  });
  expect(fit.sidewaysScroll, `${surface}: the popup must not scroll sideways`).toBeLessThanOrEqual(1);
  expect(fit.escaped, `${surface}: every control must stay inside the popup width`).toEqual([]);
}

// The whole file drives extension pages, which Playwright Firefox cannot reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);
test.describe.configure({ retries: 0 });

for (const locale of sweptLocales()) {
  test(`${locale}: popup, sign-in and onboarding render translated and fit`, async () => {
    const messages = catalog(locale);
    // keepOnboardingTab: the launcher closes any page that navigates to
    // onboarding.html, and this case navigates to it on purpose.
    const session = await ext.launchSession({ locale: langTag(locale), keepOnboardingTab: true });
    try {
      const extensionId = await ext.resolveExtensionId(session.context);
      expect(extensionId, "the extension must load before its pages are read").not.toBeNull();
      if (!extensionId) throw new Error("Missing Emojery extension id");

      const popup = await ext.openPopup(session.context);
      try {
        await popup.setViewportSize(POPUP_VIEWPORT);
        for (const key of ["tabSettings", "tabHistory", "tabAccount", "tabReport"]) {
          await expect(popup.getByRole("tab", { name: messageFor(messages, key), exact: true }), `${locale}: the ${key} tab should carry its translation`).toBeVisible();
        }
        // One Settings row, to prove the body is translated and not just the tab strip.
        await expect(popup.getByText(messageFor(messages, "settingEnabledHint"), { exact: true })).toBeVisible();
        await expectNoRawMessageKeys(popup, `${locale} popup`);
        await expectFitsPopupWidth(popup, `${locale} popup`);
      } finally {
        await popup.close().catch(() => {});
      }

      const page = await session.context.newPage();
      try {
        await page.goto(ext.extensionPageUrl(extensionId, "auth.html"));
        await expect(page.getByRole("heading", { name: messageFor(messages, "authSignInTitle") })).toBeVisible();
        await expect(page.getByRole("button", { name: messageFor(messages, "authSendCodeBtn") })).toBeVisible();
        await expectNoRawMessageKeys(page, `${locale} auth`);

        await page.goto(ext.extensionPageUrl(extensionId, "onboarding.html"));
        await expect(page.getByRole("heading", { name: messageFor(messages, "onboardingTitle") })).toBeVisible();
        await expect(page.getByRole("link", { name: messageFor(messages, "onboardingTryBtn") })).toBeVisible();
        await expectNoRawMessageKeys(page, `${locale} onboarding`);
      } finally {
        await page.close().catch(() => {});
      }
    } finally {
      await ext.closeSession(session);
    }
  });
}
