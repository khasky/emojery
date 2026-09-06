// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which supported sites does a set of changed adapter files touch?
//
// Feeds the `-g` filter of the PR-time adapter sweep (.github/workflows/e2e-adapter.yml),
// which runs the live placement check only for the sites a pull request can actually have
// broken. Takes the changed paths on argv, prints one site id per line.
//
// The mapping is by FILENAME, because that is the adapter convention the repo already
// follows: `<site>.ts`, plus `<site>-<part>.ts` where one site's knowledge outgrew a single
// file (facebook-target.ts, facebook-post-row.ts, ...). The stem before the first dash is
// the candidate; the registry decides whether it is a site.
//
// A changed file whose stem is NOT a site is shared toolkit - framework.ts, action-row.ts,
// placement.ts, runtime.ts. Its blast radius is every adapter, not one, so it yields the
// WHOLE registry rather than nothing: a toolkit regression that only shows up on YouTube is
// exactly what a per-site filter would hide.
//
// The site list is imported from the registry rather than restated here - node runs the
// TypeScript directly (type stripping, node >= 24 per package.json engines), so this stays a
// reader of the single source of truth instead of a second copy of it.
import { ALL_SITES } from "../src/shared/sites.ts";

const ADAPTER_DIR = "src/adapters/";

/**
 * @param {readonly string[]} changedPaths - repo-relative paths, any separator.
 * @param {readonly string[]} sites - the registry (`ALL_SITES`).
 * @returns {string[]} site ids to run, in registry order; empty when no adapter changed.
 */
export function adapterSitesFromDiff(changedPaths, sites) {
  // `.test.ts` is excluded on purpose: a unit test cannot change what mounts on a live
  // page, and a PR that only edits one must not spend a browser sweep proving it.
  const adapterFiles = changedPaths.map((p) => p.replaceAll("\\", "/")).filter((p) => p.startsWith(ADAPTER_DIR) && p.endsWith(".ts") && !p.endsWith(".test.ts"));
  if (adapterFiles.length === 0) return [];

  const known = new Set(sites);
  const hit = new Set();
  for (const path of adapterFiles) {
    // `src/adapters/facebook-post-row.test.ts` -> `facebook`; `framework.ts` -> `framework`.
    const stem = path.slice(ADAPTER_DIR.length).replace(/\.ts$/, "");
    const candidate = stem.split("-")[0] ?? "";
    // A toolkit file short-circuits the whole answer: no per-site filter is honest once
    // the code every adapter calls has moved.
    if (!known.has(candidate)) return [...sites];
    hit.add(candidate);
  }
  // Registry order, so the printed list is stable whatever order the diff arrived in.
  return sites.filter((s) => hit.has(s));
}

// `import.meta.main` (node >= 24) rather than an argv[1] comparison: the test imports this
// module, and a path compare across Windows separators is exactly the kind of thing that
// silently runs the CLI half inside the suite.
if (import.meta.main) {
  const sites = adapterSitesFromDiff(process.argv.slice(2), ALL_SITES);
  if (sites.length > 0) console.log(sites.join("\n"));
}
