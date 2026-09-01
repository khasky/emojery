// SPDX-License-Identifier: GPL-3.0-or-later
//
// i18n UI completeness: every string the UI renders is present and well-formed
// in every shipped locale, so a translated UI never falls back to English
// mid-screen and the extension never fails to load on a bad placeholder (a
// missing `placeholders` entry fails the WHOLE extension load, per-locale).
//
// NOTE: layout overflow (e.g. the long German "Verifizierungscode") is a
// RENDER concern - a manual visual check; this only guarantees data presence.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const LOCALES_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../public/_locales");

interface MessageEntry {
  message?: string;
  placeholders?: Record<string, unknown>;
}
type Messages = Record<string, MessageEntry>;

function readLocale(locale: string): Messages {
  return JSON.parse(readFileSync(resolve(LOCALES_DIR, locale, "messages.json"), "utf8"));
}

const LOCALES = readdirSync(LOCALES_DIR).filter((d) => statSync(resolve(LOCALES_DIR, d)).isDirectory());
const EN = readLocale("en");
const EN_KEYS = Object.keys(EN);
const NON_EN = LOCALES.filter((l) => l !== "en");
const PLACEHOLDER_RE = /\$([A-Z_]+)\$/g;

describe("i18n locales", () => {
  it("ships en plus the load-bearing translations", () => {
    expect(LOCALES).toContain("en");
    // ru/uk also face the stricter no-backlog gate below; de/ja are only checked for presence.
    for (const l of ["de", "ru", "uk", "ja"]) expect(LOCALES).toContain(l);
  });

  // Placeholder parity (a missing entry fails the whole extension load).
  it.each(LOCALES)("%s: every $PLACEHOLDER$ used is defined", (locale) => {
    const data = readLocale(locale);
    const missing: string[] = [];
    for (const [key, entry] of Object.entries(data)) {
      const used = new Set([...(entry.message ?? "").matchAll(PLACEHOLDER_RE)].map((m) => m[1]!.toLowerCase()));
      const defined = new Set(Object.keys(entry.placeholders ?? {}).map((s) => s.toLowerCase()));
      for (const ph of used) if (!defined.has(ph)) missing.push(`${key} -> $${ph.toUpperCase()}$`);
    }
    expect(missing, `undefined placeholders in ${locale}`).toEqual([]);
  });

  it.each(NON_EN)("%s: defines no keys absent from en", (locale) => {
    const orphans = Object.keys(readLocale(locale)).filter((k) => !(k in EN));
    expect(orphans, `orphan keys in ${locale}`).toEqual([]);
  });

  // Coverage: every en key is translated (non-empty) in every locale,
  // EXCEPT a small, explicit backlog awaiting translation (those fall back to
  // en at runtime, which is valid). A newly-added en string left untranslated
  // fails here until it's translated or consciously added to the backlog - the
  // i18n-completeness regression guard. Empty today: keep it that way by
  // translating the string rather than parking it here.
  const PENDING_TRANSLATION = new Set<string>();

  function missingKeys(locale: string): string[] {
    const data = readLocale(locale);
    return EN_KEYS.filter((k) => typeof data[k]?.message !== "string" || data[k]!.message!.trim() === "");
  }

  it.each(NON_EN)("%s: translates every en key (outside the known backlog)", (locale) => {
    const gaps = missingKeys(locale).filter((k) => !PENDING_TRANSLATION.has(k));
    expect(gaps, `untranslated keys in ${locale} - translate them or add to PENDING_TRANSLATION`).toEqual([]);
  });

  it("fully translates the primary locales (ru, uk) with no backlog", () => {
    for (const locale of ["ru", "uk"]) {
      expect(missingKeys(locale), `${locale} must be fully translated`).toEqual([]);
    }
  });

  // Skipped while the backlog is empty - iterating nothing and reporting green reads
  // as coverage it isn't. Becomes a real check the moment a key is parked above.
  it.skipIf(PENDING_TRANSLATION.size === 0)("keeps PENDING_TRANSLATION honest (each entry is a real en key still untranslated somewhere)", () => {
    for (const key of PENDING_TRANSLATION) {
      expect(EN_KEYS, `backlog key '${key}' is not an en key`).toContain(key);
      const stillMissing = NON_EN.some((l) => {
        const m = readLocale(l)[key]?.message;
        return typeof m !== "string" || m.trim() === "";
      });
      expect(stillMissing, `backlog key '${key}' is now translated everywhere - remove it`).toBe(true);
    }
  });
});
