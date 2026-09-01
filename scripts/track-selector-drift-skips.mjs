#!/usr/bin/env node
// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Consecutive-skip tracker for the selector-drift probe. A single skipped run
// is normal (anti-bot walls vary day to day), but a scenario that skips EVERY
// day is a site the probe has silently gone blind on - its selectors could all
// be dead and the daily green would never say so. Counters persist between
// runs via the workflow's cache step; a scenario reaching the threshold fails
// the job with an actionable message.
//
// One class of blindness is NOT actionable: a site that hard-blocks the runner's
// datacenter IP outright (Reddit answers every GitHub-hosted runner with "You've
// been blocked by network security"). No fixture URL or probe tweak reaches it,
// so failing daily only trains everyone to ignore this job. Those scenarios are
// declared in E2E_DRIFT_KNOWN_BLOCKED and reported as an uncovered gap instead -
// they are covered by running the probe off a CI IP (see e2e/README.md).
//
// Usage: node scripts/track-selector-drift-skips.mjs <playwright.json> <state.json>
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { forEachTest } from "./lib/playwright-report.mjs";

const reportFile = process.argv[2] ?? "test-results/selector-drift.json";
const stateFile = process.argv[3] ?? ".selector-drift-state/counters.json";
const threshold = Number(process.env.E2E_DRIFT_MAX_CONSECUTIVE_SKIPS ?? 5);
// Comma-separated scenario-title prefixes (the site id, e.g. `reddit:`) this
// runner is known to be unable to reach at all.
const knownBlocked = (process.env.E2E_DRIFT_KNOWN_BLOCKED ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean);
// The exemption only holds for the two reasons the probe itself records for a
// walled page (spec: navigation failure, then wallReason). A listed scenario
// that skips for anything else is still counted - the block is the excuse, not
// the site id.
const WALL_REASON_RE = /anti-bot|navigation blocked/i;

let report;
try {
  report = JSON.parse(readFileSync(reportFile, "utf8"));
} catch (e) {
  console.error(`track-selector-drift-skips: cannot read ${reportFile}: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}

let counters = {};
try {
  counters = JSON.parse(readFileSync(stateFile, "utf8"));
} catch {
  // First run (or an expired cache): every counter starts at 0.
}

const seen = new Map(); // spec title -> skip reason, or null when it ran
forEachTest(report.suites, (test, spec) => {
  const skip = /** @type {Array<{ type: string; description?: string }>} */ (test.annotations ?? []).find((a) => a.type === "skip");
  seen.set(spec.title, test.status === "skipped" ? (skip?.description ?? "no reason recorded") : null);
});

const blind = [];
const uncovered = [];
const stale = [];
for (const [title, reason] of seen) {
  const listed = knownBlocked.some((prefix) => title.startsWith(prefix));
  if (listed && reason !== null && WALL_REASON_RE.test(reason)) {
    // Declared unreachable: keep the counter at 0 so a later, genuinely silent
    // skip on this scenario still needs `threshold` runs of its own to fire.
    counters[title] = 0;
    uncovered.push(`${title} - ${reason}`);
    continue;
  }
  if (listed && reason === null) stale.push(title);
  counters[title] = reason !== null ? (counters[title] ?? 0) + 1 : 0;
  if (counters[title] >= threshold) blind.push(`${title} - skipped ${counters[title]} runs in a row (last reason: ${reason})`);
}

mkdirSync(dirname(stateFile), { recursive: true });
writeFileSync(stateFile, JSON.stringify(counters, null, 2));

const skippedNow = [...seen.entries()].filter(([, reason]) => reason !== null).map(([title]) => title);
console.log(`selector-drift skips this run: ${skippedNow.length ? skippedNow.join(", ") : "none"}`);
if (uncovered.length > 0) {
  console.log(`selector-drift NOT COVERED here (${uncovered.length} scenario(s) this runner cannot reach; probe them off a CI IP):`);
  for (const line of uncovered) console.log(`  ${line}`);
}
for (const title of stale) {
  console.log(`selector-drift: "${title}" loaded fine - drop its prefix from E2E_DRIFT_KNOWN_BLOCKED so the gate covers it again.`);
}

if (blind.length > 0) {
  console.error(`track-selector-drift-skips: the probe has been blind on ${blind.length} scenario(s) for ${threshold}+ consecutive runs:`);
  for (const line of blind) console.error(`  ${line}`);
  console.error("The site walls the probe daily - its selectors could be dead without any signal. Refresh the fixture URL or probe strategy.");
  process.exit(1);
}
