// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Content-script weight gate. Two things are checked:
//
//   1. No English message dictionary. `shared/i18n.ts` imports it for the Vitest/jsdom
//      fallback only; `__EM_I18N_FALLBACK__` (wxt.config.ts) folds that branch away so
//      rollup drops the JSON. Losing the fold adds the whole dictionary to every content
//      script and is invisible - the extension keeps working, because chrome.i18n answers
//      anyway.
//   2. A per-bundle byte ceiling, so growth has to be noticed and argued rather than
//      discovered in a store review.
//
// Both limits live in lib/bundle-budget.mjs, where the unit test reads the same values.
//
// Run after a build: node scripts/check-bundle-budget.mjs [outDir]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLE_LIMITS, contentScriptIssues, DISTINCTIVE_MESSAGE_LENGTH, distinctiveMessages } from "./lib/bundle-budget.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(__dirname, "..", process.argv[2] ?? ".output/chrome-mv3");
const contentDir = resolve(outDir, "content-scripts");

const messages = JSON.parse(readFileSync(resolve(__dirname, "../src/shared/__generated__/messages-en.json"), "utf8"));
const distinctive = distinctiveMessages(messages, DISTINCTIVE_MESSAGE_LENGTH);

if (distinctive.length === 0) {
  console.error("check-bundle-budget: no distinctive messages to search for - the dictionary check would pass vacuously.");
  process.exit(1);
}

let issues = 0;
const files = readdirSync(contentDir).filter((name) => name.endsWith(".js"));
if (files.length === 0) {
  console.error(`check-bundle-budget: no content scripts in ${contentDir} - build first.`);
  process.exit(1);
}

for (const name of files.sort()) {
  const path = resolve(contentDir, name);
  const bytes = statSync(path).size;
  const source = readFileSync(path, "utf8");
  const found = distinctive.filter((message) => source.includes(message));

  for (const issue of contentScriptIssues({ name, bytes, inlined: found.length }, BUNDLE_LIMITS)) {
    console.error(issue);
    issues++;
  }
  console.log(`${name.padEnd(16)} ${String(bytes).padStart(7)} bytes  ${found.length} inlined messages`);
}

if (issues > 0) {
  console.error(`\ncheck-bundle-budget: ${issues} issue(s).`);
  process.exit(1);
}
console.log(`\ncheck-bundle-budget: ${files.length} content scripts within budget.`);
