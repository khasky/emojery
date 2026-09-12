// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The drift tracker decides whether the daily probe goes red, so the two ways it
// can be wrong both cost days: a gate that never fires hides a site the probe has
// gone blind on, and a gate that fires on an unreachable site (Reddit blocks
// every CI IP) is a red nobody can act on. Both directions are pinned here.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, expect, it } from "vitest";

// From the file URL string, never `new URL(...)`: this suite runs in the jsdom
// environment, whose global URL is not the one node:url expects.
const script = join(dirname(fileURLToPath(import.meta.url)), "track-selector-drift-skips.mjs");
const workDir = mkdtempSync(join(tmpdir(), "drift-tracker-"));
afterAll(() => rmSync(workDir, { recursive: true, force: true }));

const REDDIT_WALL = 'reddit: anti-bot interstitial: "You\'ve been blocked by network security."';

/** One scenario per entry: `[title, skipReason]`, a null reason meaning it ran. */
function report(entries) {
  return {
    suites: [
      {
        title: "selector-drift.spec.ts",
        specs: entries.map(([title, reason]) => ({
          title,
          tests: [
            {
              status: reason === null ? "expected" : "skipped",
              annotations: reason === null ? [] : [{ type: "skip", description: reason }],
            },
          ],
        })),
      },
    ],
  };
}

let runId = 0;
function track(entries, counters, env = {}) {
  const id = `run-${runId++}`;
  const reportFile = join(workDir, `${id}.report.json`);
  const stateFile = join(workDir, `${id}.state.json`);
  writeFileSync(reportFile, JSON.stringify(report(entries)));
  writeFileSync(stateFile, JSON.stringify(counters));
  const run = spawnSync(process.execPath, [script, reportFile, stateFile], {
    encoding: "utf8",
    env: { ...process.env, E2E_DRIFT_KNOWN_BLOCKED: "", ...env },
  });
  return { code: run.status, out: `${run.stdout}${run.stderr}`, state: JSON.parse(readFileSync(stateFile, "utf8")) };
}

const AT_THRESHOLD = { "reddit: Reddit post scenario selectors alive": 4 };

it("fails on a scenario that has skipped the threshold number of runs", () => {
  const { code, out } = track([["reddit: Reddit post scenario selectors alive", REDDIT_WALL]], AT_THRESHOLD);
  expect(code).toBe(1);
  expect(out).toContain("skipped 5 runs in a row");
});

it("reports a declared-unreachable scenario as an uncovered gap instead", () => {
  const { code, out } = track([["reddit: Reddit post scenario selectors alive", REDDIT_WALL]], AT_THRESHOLD, { E2E_DRIFT_KNOWN_BLOCKED: "reddit:" });
  expect(code).toBe(0);
  expect(out).toContain("NOT COVERED here");
});

it("still counts a declared scenario that skipped for a reason other than a wall", () => {
  const { code, out } = track([["reddit: Reddit post scenario selectors alive", "fixture post deleted"]], AT_THRESHOLD, { E2E_DRIFT_KNOWN_BLOCKED: "reddit:" });
  expect(code).toBe(1);
  expect(out).toContain("fixture post deleted");
});

it("keeps quiet when a declared scenario slips through the wall once", () => {
  const { code, out } = track([["reddit: Reddit post scenario selectors alive", null]], {}, { E2E_DRIFT_KNOWN_BLOCKED: "reddit:" });
  expect(code).toBe(0);
  expect(out).not.toContain("drop its prefix from E2E_DRIFT_KNOWN_BLOCKED");
});

it("names a declared scenario that loads a whole threshold of runs, so the exemption gets dropped", () => {
  const { code, out } = track([["reddit: Reddit post scenario selectors alive", null]], { "reddit: Reddit post scenario selectors alive": -4 }, { E2E_DRIFT_KNOWN_BLOCKED: "reddit:" });
  expect(code).toBe(0);
  expect(out).toContain("drop its prefix from E2E_DRIFT_KNOWN_BLOCKED");
});

it("restarts the skip count at 1 for a scenario whose exemption was just dropped", () => {
  // The clean-run countdown left the counter negative; climbing out of that hole
  // would cost the gate `threshold` extra runs before it could ever fire again.
  const { code, state } = track([["reddit: Reddit post scenario selectors alive", REDDIT_WALL]], { "reddit: Reddit post scenario selectors alive": -4 });
  expect(code).toBe(0);
  expect(state["reddit: Reddit post scenario selectors alive"]).toBe(1);
});

it("exempts one scenario title without exempting its site's siblings", () => {
  const walled = ["x: X profile feed scenario selectors alive", 'x: anti-bot interstitial: "Performing security verification"'];
  const sibling = ["x: X status detail scenario selectors alive", 'x: anti-bot interstitial: "Performing security verification"'];
  const { code, out } = track([walled, sibling], { "x: X status detail scenario selectors alive": 4 }, { E2E_DRIFT_KNOWN_BLOCKED: "x: X profile feed" });
  expect(code).toBe(1);
  expect(out).toContain("NOT COVERED here");
  expect(out).toContain("x: X status detail scenario selectors alive - skipped 5 runs in a row");
});
