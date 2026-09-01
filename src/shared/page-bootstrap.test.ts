// SPDX-License-Identifier: GPL-3.0-or-later
//
// First-paint stamping for the extension's OWN pages (popup, auth, onboarding) -
// extension-owned document, no supported-site DOM, per CONTRIBUTING.md.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bootstrapPage } from "./page-bootstrap";

function installChromeI18n(uiLanguage: string | undefined): void {
  vi.stubGlobal("chrome", uiLanguage === undefined ? {} : { i18n: { getUILanguage: () => uiLanguage } });
}

beforeEach(() => {
  document.documentElement.removeAttribute("lang");
  delete document.documentElement.dataset.theme;
  document.title = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootstrapPage", () => {
  it("stamps the localized title and a resolved theme before the first paint", () => {
    installChromeI18n("de");
    bootstrapPage("Emojery Einstellungen");

    expect(document.title).toBe("Emojery Einstellungen");
    // "system" resolves against the browser, so the attribute is one of the two
    // palettes - never the literal preference, which would match no CSS rule.
    expect(document.documentElement.dataset.theme).toMatch(/^(light|dark)$/);
  });

  it("follows the UI locale on <html lang> (WCAG 3.1.1), not a hardcoded en", () => {
    installChromeI18n("uk");
    bootstrapPage("Заголовок");
    expect(document.documentElement.lang).toBe("uk");
  });

  it("leaves lang alone where the i18n API is absent, rather than guessing en", () => {
    installChromeI18n(undefined);
    bootstrapPage("Title");
    expect(document.documentElement.hasAttribute("lang")).toBe(false);
    expect(document.title).toBe("Title");
  });

  it("does not read storage unless the caller asks to follow the stored theme", async () => {
    const get = vi.fn();
    vi.stubGlobal("chrome", { i18n: { getUILanguage: () => "en" }, storage: { sync: { get } } });

    bootstrapPage("Title");
    await Promise.resolve();
    expect(get).not.toHaveBeenCalled();
  });
});
