// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drift guard for the repo's strictest testing rule: a unit test must not simulate a
// supported site's page. Same shape as shared/e2e-site-coverage.test.ts - a rule that
// only lived in prose, made mechanical.
//
// Two gates, one per way into a fake site tree:
//
//   1. Driving a real site adapter's `scan()`. That call only means anything against a
//      constructed page, so a unit test reaching for it has by definition built one.
//   2. Building DOM in a test that imports a per-site HELPER module (facebook-post-row.ts,
//      facebook-target.ts, ...). Those hold the row walks the adapter delegates to, carry no
//      `defineSiteAdapter({` and so are invisible to gate 1, and every element they accept is
//      Facebook's own markup - there is no generic tree worth handing them.
//
// Deliberately NOT a blanket ban on `createElement` / `innerHTML`: generic sentinels,
// Emojery's own UI, the SHARED toolkit (visual-action-row, placement, action-labels) and
// framework.test.ts's own-callback `scan()` all stay legal.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_SITES } from "../shared/sites";

const SRC_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ADAPTERS_DIR = resolve(SRC_DIR, "adapters");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) return walk(full);
    return [full];
  });
}

// A site adapter is a module that registers one - not every file in adapters/ is
// (framework.ts, action-row.ts, url-target.ts and friends are shared machinery).
function adapterSources(): Array<{ file: string; name: string; source: string }> {
  return readdirSync(ADAPTERS_DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ file: resolve(ADAPTERS_DIR, name), name, source: readFileSync(resolve(ADAPTERS_DIR, name), "utf8") }));
}

function siteAdapterModules(): string[] {
  return adapterSources()
    .filter((entry) => entry.source.includes("defineSiteAdapter({"))
    .map((entry) => entry.file);
}

// Named after a registered site but not the adapter itself: the per-site helper modules the
// adapter delegates its DOM work to. Derived from the registry so a new site's helpers are
// covered without editing this list.
function siteHelperModules(): string[] {
  return adapterSources()
    .filter((entry) => !entry.source.includes("defineSiteAdapter({"))
    .filter((entry) => ALL_SITES.some((site) => entry.name.startsWith(`${site}-`)))
    .map((entry) => entry.file);
}

function unitTestFiles(): string[] {
  return walk(SRC_DIR).filter((file) => /\.test\.tsx?$/.test(file) && !file.endsWith(".browser.test.ts") && !file.endsWith(".browser.test.tsx"));
}

// Every module path a file imports, resolved to an absolute .ts path when relative.
function importedModules(file: string, source: string): string[] {
  const dir = dirname(file);
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/g)]
    .map((match) => match[1])
    .filter((spec): spec is string => !!spec?.startsWith("."))
    .map((spec) => resolve(dir, `${spec}.ts`));
}

describe("unit tests never drive a real site adapter's scan()", () => {
  const adapters = siteAdapterModules();

  it("finds the site adapter modules it is meant to guard", () => {
    // A rename that emptied this list would make every assertion below vacuous.
    expect(adapters.length).toBeGreaterThan(5);
  });

  for (const file of unitTestFiles()) {
    const source = readFileSync(file, "utf8");
    const imported = importedModules(file, source).filter((mod) => adapters.includes(mod));
    if (imported.length === 0) continue;

    const name = relative(SRC_DIR, file).replaceAll("\\", "/");
    it(`${name} imports a site adapter but does not scan with it`, () => {
      expect(
        source.includes(".scan("),
        `${name} imports ${imported.map((mod) => relative(SRC_DIR, mod).replaceAll("\\", "/")).join(", ")} and calls .scan(). ` +
          "Driving a site adapter's scan needs a fake supported-site DOM, which pins a snapshot of markup the site owns. " +
          "Move the check to an e2e spec (e2e/site-injection.spec.ts) and keep the unit test on the adapter's URL/id parsing, host matching, or label reading.",
      ).toBe(false);
    });
  }
});

describe("unit tests never build DOM for a per-site helper module", () => {
  const helpers = siteHelperModules();

  it("finds the per-site helper modules it is meant to guard", () => {
    // Same vacuity check as above: a rename that emptied this list would make the
    // assertions below pass against nothing.
    expect(helpers.length).toBeGreaterThan(0);
  });

  for (const file of unitTestFiles()) {
    const source = readFileSync(file, "utf8");
    const imported = importedModules(file, source).filter((mod) => helpers.includes(mod));
    if (imported.length === 0) continue;

    const name = relative(SRC_DIR, file).replaceAll("\\", "/");
    it(`${name} imports a per-site helper but builds no DOM`, () => {
      expect(
        source.includes("createElement") || source.includes("innerHTML"),
        `${name} imports ${imported.map((mod) => relative(SRC_DIR, mod).replaceAll("\\", "/")).join(", ")} and builds DOM. ` +
          "Every element those modules accept is the site's own markup, so the tree can only be a fake of it - which pins a snapshot the site owns. " +
          "Move the check to an e2e spec (e2e/site-injection.spec.ts) and keep the unit test on the helper's string-only exports (URL and label parsing).",
      ).toBe(false);
    });
  }
});
