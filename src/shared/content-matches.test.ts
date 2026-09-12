// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drift guard: each `entrypoints/<site>.content.ts` takes its `matches` from the
// site registry and wires that site's adapter - two hand-written facts per file
// that only a live e2e run would otherwise catch when they name different sites
// (`github.content.ts` importing the GitLab adapter, or asking for GitLab's hosts,
// compiles and passes every other unit test). Reads the files as TEXT -
// importing would execute `defineContentScript`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_SITES } from "./sites";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINTS_DIR = resolve(HERE, "../entrypoints");
const REPO_ROOT = resolve(HERE, "../..");

function entrypointSource(name: string): string {
  return readFileSync(resolve(ENTRYPOINTS_DIR, `${name}.content.ts`), "utf8");
}

describe("each entrypoint names its own site for both its hosts and its adapter", () => {
  for (const site of ALL_SITES) {
    it(`${site}.content.ts asks the registry for the ${site} hosts and wires the ${site} adapter`, () => {
      const source = entrypointSource(site);
      expect(source, `${site}.content.ts must take its matches from matchPatternsForSite("${site}")`).toContain(`matches: matchPatternsForSite("${site}")`);
      expect(source, `${site}.content.ts must import its own adapter from ../adapters/${site}`).toMatch(new RegExp(`^import\\s+(\\w+)\\s+from\\s+"\\.\\./adapters/${site}";$`, "m"));
      const imported = source.match(new RegExp(`^import\\s+(\\w+)\\s+from\\s+"\\.\\./adapters/${site}";$`, "m"))?.[1];
      expect(source, `${site}.content.ts must hand ${imported} to contentEntryMain`).toContain(`contentEntryMain(${imported})`);
    });
  }
});

// Soft drift guard: the README table is human prose, so labels can't match
// strictly - but the row COUNT must equal the number of supported sites,
// catching "added a site, forgot the README row" (adding-a-site step 7).
describe("README Supported-sites table stays in sync with the registry", () => {
  it("has exactly one data row per supported site", () => {
    const readme = readFileSync(resolve(REPO_ROOT, "README.md"), "utf8");
    const section = readme.split(/^## /m).find((part) => part.startsWith("Supported sites"));
    expect(section, "no '## Supported sites' section in README.md").toBeTruthy();
    const tableRows = (section ?? "").split("\n").filter((line) => line.trim().startsWith("|"));
    // Drop the header row + the `| --- | --- |` separator.
    expect(tableRows.length - 2).toBe(ALL_SITES.length);
  });
});
