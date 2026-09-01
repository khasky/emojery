// SPDX-License-Identifier: GPL-3.0-or-later
//
// Drift guard for docs/adding-a-site.md step 9: a registered site with no e2e
// scenario ships with ZERO live coverage while every other gate stays green, and
// the e2e suites can't catch it - they iterate their own tables. Reaches into
// `e2e/` on purpose: both scenario modules are data-only (no Playwright import,
// no env read at module load), precisely so this import stays cheap.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEEP_SITES, SMOKE_SITES } from "../../e2e/site-auth/scenarios";
import { SUPPORTED_SITE_SCENARIOS } from "../../e2e/supported-sites";
import { deriveTargetFromUrl, URL_DERIVABLE_SITES } from "../adapters/target-contract";
import { ALL_SITES } from "./sites";
import { targetKey } from "./storage";

// `.env.e2e.example` is the CHECKED-IN fixture-URL registry every suite falls back
// to (e2e/lib/load-env.ts reads it first), so reading it here costs nothing and
// needs no local env file.
const ENV_EXAMPLE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../..", ".env.e2e.example"), "utf8");

function envExampleKeys(): Set<string> {
  return new Set(Array.from(ENV_EXAMPLE.matchAll(/^([A-Z0-9_]+)=(.*)$/gm), (m) => (m[2]?.trim() ? m[1]! : "")).filter(Boolean));
}

describe("unauthenticated e2e scenarios cover every registered site", () => {
  for (const site of ALL_SITES) {
    it(`${site} has at least one scenario in e2e/supported-sites.ts`, () => {
      const scenarios = SUPPORTED_SITE_SCENARIOS.filter((scenario) => scenario.site === site);
      expect(scenarios.length, `${site}: add a scenario to SUPPORTED_SITE_SCENARIOS (adding-a-site step 9)`).toBeGreaterThan(0);
    });
  }

  it("has no scenario for a site that is not registered", () => {
    const registered = new Set<string>(ALL_SITES);
    const strays = SUPPORTED_SITE_SCENARIOS.filter((scenario) => !registered.has(scenario.site)).map((scenario) => scenario.label);
    expect(strays, "scenario(s) for a site missing from SUPPORTED_SITES").toEqual([]);
  });

  it("gives every scenario a distinct label - the label is how a run is grepped", () => {
    const labels = SUPPORTED_SITE_SCENARIOS.map((scenario) => scenario.label);
    expect(labels.length).toBe(new Set(labels).size);
  });

  it("names an E2E_URL_<key> for every scenario", () => {
    for (const scenario of SUPPORTED_SITE_SCENARIOS) {
      expect(scenario.urlKey, `${scenario.label}: urlKey must be an E2E_URL_ suffix`).toMatch(/^[A-Z0-9_]+$/);
    }
  });

  // ...and that suffix has to RESOLVE. Without this the scenario row is guarded but
  // its fixture URL is not: `envUrl()` throws only once a live browser run reaches
  // that scenario, long after `pnpm check` went green (adding-a-site step 9).
  it("gives every scenario urlKey a non-empty E2E_URL_ row in .env.e2e.example", () => {
    const declared = envExampleKeys();
    const missing = SUPPORTED_SITE_SCENARIOS.filter((scenario) => !declared.has(`E2E_URL_${scenario.urlKey}`)).map((scenario) => `${scenario.label} -> E2E_URL_${scenario.urlKey}`);
    expect(missing, "add the fixture URL to .env.e2e.example (adding-a-site step 9)").toEqual([]);
  });

  it("declares no E2E_URL_ fixture that no scenario uses", () => {
    const used = new Set(SUPPORTED_SITE_SCENARIOS.map((scenario) => `E2E_URL_${scenario.urlKey}`));
    const strays = [...envExampleKeys()].filter((key) => key.startsWith("E2E_URL_") && !used.has(key));
    expect(strays, "stale fixture URL(s) in .env.e2e.example - drop the row or add the scenario").toEqual([]);
  });

  // `mountKeyPattern` literals in supported-sites.ts must track the adapters'
  // actual key shape - before this guard, drift showed up only as a live-site
  // e2e failure. For every URL-derivable site, a key built by the REAL
  // derivation from a representative URL must satisfy every one of that site's
  // scenario patterns. (facebook/gitlab keys need page state; live e2e owns those.)
  it("every URL-derivable site's scenario mountKeyPattern accepts a real derived key", () => {
    // Frozen parse vectors, never fetched - only the URL SHAPE is under test, so
    // a deleted post is not drift and needs no refresh.
    const representativeUrl: Record<string, string> = {
      x: "https://x.com/Pirat_Nation/status/2058156237737295928",
      youtube: "https://www.youtube.com/watch?v=Pjb7tRmjwag",
      reddit: "https://www.reddit.com/r/coolgithubprojects/comments/1tezfl7/open_source_palantir_on_git/",
      instagram: "https://www.instagram.com/p/DYUhRl8OWQU/",
      threads: "https://www.threads.com/@theromero/post/DYpmDeHjE1L",
      github: "https://github.com/facebook/react",
      amazon: "https://www.amazon.com/dp/B00ZV9RDKK",
    };
    for (const site of URL_DERIVABLE_SITES) {
      const url = representativeUrl[site];
      expect(url, `${site}: add a representative URL to this guard`).toBeDefined();
      if (!url) continue;
      const target = deriveTargetFromUrl(site, url);
      expect(target, `${site}: representative URL stopped deriving`).not.toBeNull();
      if (!target) continue;
      const key = targetKey({ site, targetId: target.targetId, url: target.url });
      for (const scenario of SUPPORTED_SITE_SCENARIOS.filter((s) => s.site === site)) {
        expect(new RegExp(scenario.mountKeyPattern).test(key), `${scenario.label}: mountKeyPattern ${scenario.mountKeyPattern} rejects the real derived key "${key}" - the pattern drifted from the adapter`).toBe(true);
      }
    }
  });
});

describe("site-authenticated e2e covers every registered site", () => {
  // site-auth/README.md promises ALL supported sites on every run, split into
  // the deep (feed-heavy, bot-sensitive) and smoke tiers.
  it("puts every registered site in exactly one of DEEP_SITES / SMOKE_SITES", () => {
    for (const site of ALL_SITES) {
      const tiers = [DEEP_SITES.includes(site) ? "deep" : null, SMOKE_SITES.includes(site) ? "smoke" : null].filter(Boolean);
      expect(tiers, `${site}: add it to DEEP_SITES or SMOKE_SITES in e2e/site-auth/scenarios.ts`).toHaveLength(1);
    }
  });

  it("lists no site that is not registered", () => {
    const registered = new Set<string>(ALL_SITES);
    expect([...DEEP_SITES, ...SMOKE_SITES].filter((site) => !registered.has(site))).toEqual([]);
  });
});
