// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared walker for a Playwright JSON report (--reporter=json) so the two skip-tracking
// gates don't each re-learn its suite -> spec -> test shape. `visit` runs for every test,
// receiving the test, its spec, and the trail of enclosing (non-empty) suite titles.

/**
 * @param {any[] | undefined} suites
 * @param {(test: any, spec: any, trail: string[]) => void} visit
 * @param {string[]} [trail]
 */
export function forEachTest(suites, visit, trail = []) {
  for (const suite of suites ?? []) {
    const path = suite.title ? [...trail, suite.title] : trail;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        visit(test, spec, path);
      }
    }
    forEachTest(suite.suites, visit, path);
  }
}
