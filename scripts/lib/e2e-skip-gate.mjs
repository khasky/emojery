// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The decision behind check-e2e-skips.mjs, split out so it can be asserted against a canned
// report instead of only in a live sweep. This gate is what decides whether every OTHER e2e
// gate's green is worth anything, so its own arithmetic is the last place to take on faith:
// under-count the skips and a sweep that verified nothing reads exactly like a healthy one.
import { forEachTest } from "./playwright-report.mjs";

/**
 * @typedef {{ passed: number, failed: number, skipped: number, flaky: number, ran: number, total: number, ratio: number, skippedTitles: string[] }} E2eTally
 */

/**
 * Count a Playwright JSON report's outcomes. `status` is Playwright's verdict for the whole
 * test including retries: expected | unexpected | flaky | skipped.
 * @param {any} report
 * @returns {E2eTally}
 */
export function tallyE2eOutcome(report) {
  const tally = { passed: 0, failed: 0, skipped: 0, flaky: 0 };
  /** @type {string[]} */
  const skippedTitles = [];

  forEachTest(report?.suites, (test, spec, path) => {
    if (test.status === "skipped") {
      tally.skipped += 1;
      skippedTitles.push([...path, spec.title].join(" › "));
    } else if (test.status === "flaky") tally.flaky += 1;
    else if (test.status === "unexpected") tally.failed += 1;
    else tally.passed += 1;
  });

  const ran = tally.passed + tally.failed + tally.flaky;
  const total = ran + tally.skipped;
  // An empty report is the worst case, not the best one: it scores as all-skipped so the
  // caller's ratio check fails it rather than dividing by zero into a green.
  return { ...tally, ran, total, ratio: total === 0 ? 1 : tally.skipped / total, skippedTitles };
}

/**
 * Why this run must not read as green, or null when it may.
 * @param {E2eTally} tally
 * @param {number} maxRatio
 * @returns {string | null}
 */
export function skipGateFailure(tally, maxRatio) {
  if (tally.total === 0) return "the report contains no tests - the run verified nothing.";
  if (tally.ratio > maxRatio) return `${tally.skipped}/${tally.total} tests skipped - the run mostly verified nothing (walls everywhere or dead fixtures). Investigate before trusting the green.`;
  return null;
}

/**
 * @param {E2eTally} tally
 * @param {number} maxRatio
 */
export function formatE2eOutcome(tally, maxRatio) {
  return `e2e outcome: ${tally.passed} passed, ${tally.flaky} flaky, ${tally.failed} failed, ${tally.skipped} skipped (skip ratio ${(tally.ratio * 100).toFixed(0)}%, gate ${(maxRatio * 100).toFixed(0)}%)`;
}
