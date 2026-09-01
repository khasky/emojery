// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The walker every skip gate reads a Playwright report through: a missed nesting level leaves skips uncounted.
import { describe, expect, it } from "vitest";
import { forEachTest } from "./playwright-report.mjs";

/** @param {string} title @param {any} extra */
const suite = (title, extra) => ({ title, ...extra });
/** @param {string} title @param {number} count */
const spec = (title, count = 1) => ({ title, tests: Array.from({ length: count }, () => ({ status: "expected" })) });

/** @param {any[] | undefined} suites */
function collect(suites) {
  /** @type {string[]} */
  const seen = [];
  forEachTest(suites, (_test, s, trail) => seen.push([...trail, s.title].join(" > ")));
  return seen;
}

describe("forEachTest", () => {
  it("visits a spec directly under a file suite", () => {
    expect(collect([suite("a.spec.ts", { specs: [spec("mounts")] })])).toEqual(["a.spec.ts > mounts"]);
  });

  // The shape the e2e config actually produces: project > file > describe > spec.
  it("descends through project and describe levels, accumulating the trail", () => {
    const report = [
      suite("live", {
        suites: [
          suite("private-pages.spec.ts", {
            suites: [suite("private-page gate", { specs: [spec("github: public repo"), spec("gitlab: public project")] })],
          }),
        ],
      }),
    ];
    expect(collect(report)).toEqual(["live > private-pages.spec.ts > private-page gate > github: public repo", "live > private-pages.spec.ts > private-page gate > gitlab: public project"]);
  });

  it("visits specs at every level, not only the deepest", () => {
    const report = [
      suite("live", {
        specs: [spec("top-level")],
        suites: [suite("nested.spec.ts", { specs: [spec("inner")] })],
      }),
    ];
    expect(collect(report)).toEqual(["live > top-level", "live > nested.spec.ts > inner"]);
  });

  it("visits every test of a spec - a retried or multi-project spec carries more than one", () => {
    /** @type {any[]} */
    const visited = [];
    forEachTest([suite("f.spec.ts", { specs: [spec("flaky", 3)] })], (t) => visited.push(t));
    expect(visited).toHaveLength(3);
  });

  it("does not extend the trail for an untitled suite", () => {
    expect(collect([suite("", { specs: [spec("bare")] })])).toEqual(["bare"]);
  });

  it("tolerates missing suites / specs / tests arrays without throwing", () => {
    expect(collect(undefined)).toEqual([]);
    expect(collect([])).toEqual([]);
    expect(collect([suite("empty", {})])).toEqual([]);
    expect(collect([suite("no tests", { specs: [{ title: "x" }] })])).toEqual([]);
  });
});
