// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every $NAME$ placeholder used in a message must be defined in that message's
// `placeholders` dict. Chrome validates this strictly per locale file (no default_locale
// fallback), and a miss fails the whole extension load with
// `Invalid locale file '...': Variable $X$ used but not defined.`
//
// Run after editing _locales/ files: node scripts/verify-locale-placeholders.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCALES = resolve(__dirname, "../public/_locales");

const PH_RE = /\$([A-Z_]+)\$/g;

let issues = 0;
const localeDirs = readdirSync(LOCALES).filter((name) => statSync(resolve(LOCALES, name)).isDirectory());

for (const locale of localeDirs) {
  const messages = JSON.parse(readFileSync(resolve(LOCALES, locale, "messages.json"), "utf8"));
  for (const [key, entry] of Object.entries(messages)) {
    const msg = entry?.message ?? "";
    const used = new Set([...msg.matchAll(PH_RE)].map((m) => m[1].toLowerCase()));
    const defined = new Set(entry?.placeholders ? Object.keys(entry.placeholders).map((s) => s.toLowerCase()) : []);
    for (const ph of used) {
      if (!defined.has(ph)) {
        console.error(`  MISSING: ${locale}/${key}  ->  $${ph.toUpperCase()}$`);
        issues++;
      }
    }
  }
}

if (issues === 0) {
  console.log(`verify-locale-placeholders: ${localeDirs.length} locales valid`);
} else {
  console.error(`verify-locale-placeholders: ${issues} missing placeholder definitions`);
  process.exit(1);
}
