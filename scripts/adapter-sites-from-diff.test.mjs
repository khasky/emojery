// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The filter decides which live sweep a pull request gets, so both ways it can be wrong
// cost something real: too narrow and a regression ships unseen (the case the sweep exists
// for), too wide and every adapter PR waits on a browser run it did not need.
import { expect, it } from "vitest";
import { ALL_SITES } from "../src/shared/sites.ts";
import { adapterSitesFromDiff } from "./adapter-sites-from-diff.mjs";

const SITES = [...ALL_SITES];

it("runs only the site whose adapter changed", () => {
  expect(adapterSitesFromDiff(["src/adapters/github.ts"], SITES)).toEqual(["github"]);
});

it("folds a multi-file site back onto one id, without repeating it", () => {
  // The whole reason the mapping is by stem-before-the-dash: Facebook's knowledge lives
  // across five files and all of them are one site to run.
  const changed = ["src/adapters/facebook.ts", "src/adapters/facebook-post-row.ts", "src/adapters/facebook-urls.ts"];
  expect(adapterSitesFromDiff(changed, SITES)).toEqual(["facebook"]);
});

it("returns sites in registry order, whatever order the diff arrived in", () => {
  const changed = ["src/adapters/youtube.ts", "src/adapters/github.ts"];
  expect(adapterSitesFromDiff(changed, SITES)).toEqual(["github", "youtube"]);
});

it("widens a shared-toolkit change to every site", () => {
  // framework.ts is called by all nine adapters. Narrowing this to the sites that happen
  // to appear beside it in the same diff is what would hide a toolkit regression that
  // only surfaces on the one site nobody touched.
  expect(adapterSitesFromDiff(["src/adapters/framework.ts", "src/adapters/github.ts"], SITES)).toEqual(SITES);
});

it("ignores adapter unit tests - they cannot change what a live page mounts", () => {
  expect(adapterSitesFromDiff(["src/adapters/github.test.ts", "src/adapters/lockstep.test.ts"], SITES)).toEqual([]);
});

it("yields nothing outside src/adapters, so an unrelated PR skips the sweep", () => {
  expect(adapterSitesFromDiff(["src/ui/mount.ts", "README.md", "src/shared/sites.ts"], SITES)).toEqual([]);
});

it("reads Windows-separated paths, which is what a local git call hands it", () => {
  expect(adapterSitesFromDiff(["src\\adapters\\reddit.ts"], SITES)).toEqual(["reddit"]);
});

it("every registered site is reachable from its own adapter file", () => {
  // The convention this filter rests on: one `src/adapters/<site>.ts` per registry row.
  // A site that stops matching it would silently never get a sweep.
  for (const site of SITES) {
    expect(adapterSitesFromDiff([`src/adapters/${site}.ts`], SITES), site).toEqual([site]);
  }
});
