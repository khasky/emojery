// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drift guard: each `entrypoints/<site>.content.ts` declares its own static
// `matches` literal (WXT extracts it at build time, so it can't be computed
// from the registry). Asserts every entrypoint equals the patterns derived from
// `sites.ts`, so a host changed in one place but not the other fails loudly.
// Reads the files as TEXT - importing would execute `defineContentScript`.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HOMEPAGE_MATCH_PATTERN } from "./homepage";
import { ALL_SITES, matchPatternsForSite } from "./sites";

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRYPOINTS_DIR = resolve(HERE, "../entrypoints");
const REPO_ROOT = resolve(HERE, "../..");

function entrypointSource(name: string): string {
  return readFileSync(resolve(ENTRYPOINTS_DIR, `${name}.content.ts`), "utf8");
}

function entrypointMatches(name: string): string[] {
  const block = entrypointSource(name).match(/matches:\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error(`no matches array found in ${name}.content.ts`);
  return Array.from(block[1]!.matchAll(/["']([^"']+)["']/g)).map((m) => m[1]!);
}

describe("entrypoint content-script matches stay in sync with the site registry", () => {
  for (const site of ALL_SITES) {
    it(`${site}.content.ts matches === matchPatternsForSite("${site}")`, () => {
      // Order-independent: content_scripts matching is set-based, so a pure
      // reordering is not drift - a missing/extra host is.
      expect([...entrypointMatches(site)].sort()).toEqual([...matchPatternsForSite(site)].sort());
    });
  }

  // The hosts an entrypoint declares and the adapter it wires are two separate
  // hand-written facts. `github.content.ts` importing the GitLab adapter compiles,
  // lints and passes every other unit test - only a live e2e run would catch it.
  for (const site of ALL_SITES) {
    it(`${site}.content.ts wires the ${site} adapter`, () => {
      const source = entrypointSource(site);
      expect(source, `${site}.content.ts must import its own adapter from ../adapters/${site}`).toMatch(new RegExp(`^import\\s+(\\w+)\\s+from\\s+"\\.\\./adapters/${site}";$`, "m"));
      const imported = source.match(new RegExp(`^import\\s+(\\w+)\\s+from\\s+"\\.\\./adapters/${site}";$`, "m"))?.[1];
      expect(source, `${site}.content.ts must hand ${imported} to contentEntryMain`).toContain(`contentEntryMain(${imported})`);
    });
  }
});

// The homepage beacon is the one content script outside the site registry, so the
// loop above never sees it. Its host is shared/homepage.ts's to own - the same host
// the popup matches on and wxt.config.ts puts in host_permissions.
describe("the homepage beacon entrypoint stays in sync with shared/homepage.ts", () => {
  it("emojery.content.ts matches === [HOMEPAGE_MATCH_PATTERN]", () => {
    expect(entrypointMatches("emojery")).toEqual([HOMEPAGE_MATCH_PATTERN]);
  });
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
