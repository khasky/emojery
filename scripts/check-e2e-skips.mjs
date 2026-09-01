#!/usr/bin/env node
// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Skip-aggregate gate for the live-site e2e runs. Skips are legitimate per test
// (anti-bot walls vary run to run), but a run where MOST scenarios skipped has
// verified nothing - and without this gate it exits green, indistinguishable
// from a healthy pass. Reads a Playwright JSON report, prints the breakdown,
// and fails when the skip ratio crosses E2E_MAX_SKIP_RATIO (default 0.5) or
// when nothing ran at all.
//
// Usage: node scripts/check-e2e-skips.mjs [path/to/e2e.json]
import { readFileSync } from "node:fs";
import { formatE2eOutcome, skipGateFailure, tallyE2eOutcome } from "./lib/e2e-skip-gate.mjs";

const file = process.argv[2] ?? "test-results/e2e.json";
const maxRatio = Number(process.env.E2E_MAX_SKIP_RATIO ?? 0.5);

let report;
try {
  report = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`check-e2e-skips: cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
  console.error("Run playwright with --reporter=list,json and PLAYWRIGHT_JSON_OUTPUT_FILE pointing at this path.");
  process.exit(1);
}

const tally = tallyE2eOutcome(report);

console.log(formatE2eOutcome(tally, maxRatio));
for (const title of tally.skippedTitles) console.log(`  skipped: ${title}`);

const failure = skipGateFailure(tally, maxRatio);
if (failure) {
  console.error(`check-e2e-skips: ${failure}`);
  process.exit(1);
}
