// SPDX-License-Identifier: GPL-3.0-or-later
//
// The gate that decides whether a live e2e sweep's green counts. Every case here is a report
// shape a real run produces - a walled sweep, a report the reporter wrote before any test ran,
// a nested describe - because the only failure mode that matters is the quiet one: a tally
// that under-counts skips and lets a sweep which verified nothing pass.
import { describe, expect, it } from "vitest";
import { skipGateFailure, tallyE2eOutcome } from "./e2e-skip-gate.mjs";

/** A report in Playwright's own shape: suites -> specs -> tests. */
const report = (statuses, { suiteTitle = "site-injection.spec.ts" } = {}) => ({
  suites: [
    {
      title: suiteTitle,
      specs: statuses.map((status, i) => ({ title: `case ${i}`, tests: [{ status }] })),
    },
  ],
});

describe("tallyE2eOutcome", () => {
  it("counts each Playwright status in its own bucket", () => {
    const tally = tallyE2eOutcome(report(["expected", "expected", "unexpected", "flaky", "skipped"]));

    expect(tally).toMatchObject({ passed: 2, failed: 1, flaky: 1, skipped: 1, ran: 4, total: 5 });
    expect(tally.ratio).toBeCloseTo(0.2);
  });

  it("names every skipped test with its full path, so the log says WHICH walled", () => {
    const tally = tallyE2eOutcome({
      suites: [
        {
          title: "site-injection.spec.ts",
          specs: [{ title: "top-level", tests: [{ status: "skipped" }] }],
          suites: [{ title: "reddit", specs: [{ title: "feed", tests: [{ status: "skipped" }] }] }],
        },
      ],
    });

    expect(tally.skippedTitles).toEqual(["site-injection.spec.ts › top-level", "site-injection.spec.ts › reddit › feed"]);
  });

  // A retried-then-green test is `flaky`, not `expected` - it ran, so it belongs on the
  // denominator's "ran" side rather than being counted as a skip or dropped entirely.
  it("counts a flaky test as having run", () => {
    const tally = tallyE2eOutcome(report(["flaky", "flaky"]));
    expect(tally).toMatchObject({ ran: 2, skipped: 0, total: 2 });
    expect(tally.ratio).toBe(0);
  });

  it("scores an empty report as fully skipped rather than dividing by zero", () => {
    for (const empty of [{ suites: [] }, {}, { suites: [{ title: "x", specs: [] }] }]) {
      const tally = tallyE2eOutcome(empty);
      expect(tally.total).toBe(0);
      expect(tally.ratio).toBe(1);
    }
  });
});

describe("skipGateFailure", () => {
  const at = (skipped, ran) => tallyE2eOutcome(report([...Array(skipped).fill("skipped"), ...Array(ran).fill("expected")]));

  it("passes a run where most scenarios actually ran", () => {
    expect(skipGateFailure(at(2, 8), 0.5)).toBeNull();
  });

  it("fails a run where the walls took most of it", () => {
    expect(skipGateFailure(at(8, 2), 0.5)).toMatch(/8\/10 tests skipped/);
  });

  // The gate is `ratio > maxRatio`, so the threshold itself passes: at exactly half, half the
  // suite did verify something. Pinned because either direction of drift is invisible in a log.
  it("passes at exactly the threshold and fails one test past it", () => {
    expect(skipGateFailure(at(5, 5), 0.5)).toBeNull();
    expect(skipGateFailure(at(6, 4), 0.5)).not.toBeNull();
  });

  it("honours a stricter or looser threshold", () => {
    expect(skipGateFailure(at(3, 7), 0.2)).not.toBeNull();
    expect(skipGateFailure(at(9, 1), 0.95)).toBeNull();
  });

  // The case the gate exists for: a report with nothing in it must never read as a clean run.
  it("fails a report with no tests at all", () => {
    expect(skipGateFailure(tallyE2eOutcome({ suites: [] }), 1)).toMatch(/no tests/);
  });

  it("fails an all-skipped run even with the loosest threshold below 1", () => {
    expect(skipGateFailure(at(10, 0), 0.99)).not.toBeNull();
  });
});
