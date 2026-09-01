// SPDX-License-Identifier: GPL-3.0-or-later
//
// Visual e2e for the private-page gate. The extension must NOT mount its
// reaction button on a page whose content isn't viewable by an anonymous public
// visitor (a private repo/project). A no-access visitor is served a 404 with no
// Star control, so the interesting case is an owner/collaborator who CAN see the
// private page - there the Star button exists and the picker would otherwise mount.
//
// We cannot sign the harness in as the owner of someone's private repo, so each
// case is an A/B pair against the SAME public URL and extension build: CONTROL
// loads the real public page (the button mounts); PRIVATE loads the same page
// with its server HTML rewritten so the visibility marker reads private, exactly
// as the owner's private view would render - the button must NOT mount even
// though the Star control is present. The rewrite AND the Star control are
// asserted so a blocked/blank page can't make the PRIVATE case falsely pass.

import { expect, type Page, test } from "@playwright/test";
import { envUrl, visibleHostCount } from "./lib/extension";
import { gotoSettled } from "./lib/page-settle";
import { pollForValue } from "./lib/picker-probes";
import { sharedSession } from "./lib/shared-session";
import { type SiteId, SUPPORTED_SITE_SCENARIOS } from "./supported-sites";

// The shared PUBLIC fixtures both the CONTROL and the PRIVATE case load (see the header).
const GITHUB_PUBLIC = envUrl("GITHUB");
const GITLAB_PUBLIC = envUrl("GITLAB");

// Six `requireStarControl` gates hang off these, so they come from
// the shared registry rather than a private copy: selector-drift.spec.ts asserts
// that same list is alive daily, which makes it the single canary. Re-listing
// them here would let a GitHub/GitLab restyle read as an anti-bot block instead.
const starSelectors = (site: SiteId): string[] => SUPPORTED_SITE_SCENARIOS.filter((scenario) => scenario.site === site).flatMap((scenario) => scenario.nativeSelectors);
const GITHUB_STAR_SELECTORS = starSelectors("github");
const GITLAB_STAR_SELECTORS = starSelectors("gitlab");

const SETTLE_MS = Number(process.env.E2E_PRIVATE_SETTLE_MS ?? 7_000);
const MOUNT_TIMEOUT_MS = Number(process.env.E2E_PRIVATE_MOUNT_TIMEOUT_MS ?? 25_000);

const session = sharedSession();

// The returned count lets the test assert the injection took effect.
async function routeRewrittenDocument(page: Page, urlPattern: RegExp, replace: (html: string) => string): Promise<() => number> {
  let rewritten = 0;
  await page.route(urlPattern, async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const original = await response.text();
    const body = replace(original);
    if (body !== original) rewritten += 1;
    const headers = { ...response.headers() };
    // The body we serve is already decoded plain text; drop the original
    // transfer headers so the browser doesn't try to gunzip/brotli it.
    delete headers["content-encoding"];
    delete headers["content-length"];
    await route.fulfill({ status: response.status(), headers, body });
  });
  return () => rewritten;
}

function waitForHostMount(page: Page): Promise<number> {
  return pollForValue(
    () => visibleHostCount(page).catch(() => 0),
    (count) => count > 0,
    MOUNT_TIMEOUT_MS,
  );
}

// Assert the button never mounts across the settle window (not just at one
// instant) - the scan is debounced and re-runs on mutation, so a late mount
// would still be a leak.
async function expectNoHostMount(page: Page): Promise<void> {
  const deadline = Date.now() + SETTLE_MS;
  while (Date.now() < deadline) {
    expect(await visibleHostCount(page).catch(() => 0)).toBe(0);
    await page.waitForTimeout(500);
  }
}

async function githubProbe(page: Page): Promise<{ hasStar: boolean; metaPublic: string | null }> {
  return page.evaluate((selectors) => {
    const star = selectors.some((s) => document.querySelector(s));
    const metaPublic = document.querySelector('meta[name="octolytics-dimension-repository_public"]')?.getAttribute("content") ?? null;
    return { hasStar: star, metaPublic };
  }, GITHUB_STAR_SELECTORS);
}

async function gitlabProbe(page: Page): Promise<{ hasStar: boolean; iconFragment: string | null }> {
  return page.evaluate((selectors) => {
    const star = selectors.some((s) => document.querySelector(s));
    const use = document.querySelector(".visibility-icon use") ?? document.querySelector('h1[data-testid="project-name-content"] svg use');
    const href = use?.getAttribute("href") ?? use?.getAttribute("xlink:href") ?? "";
    const iconFragment = href.match(/#(earth|lock|shield)\b/)?.[1] ?? null;
    return { hasStar: star, iconFragment };
  }, GITLAB_STAR_SELECTORS);
}

// Skipping on a missing Star control would disable the whole gate: one Star
// restyle empties the shared selectors, all six cases skip, and the run stays
// green while nothing checks that the extension keeps off non-public content. So
// skip ONLY when the page was never really served (anti-bot / login wall) - a
// SERVED page whose Star control is missing is selector drift, and that fails.
function requireStarControl(probe: { hasStar: boolean }, served: boolean, site: "GitHub" | "GitLab"): void {
  test.skip(!probe.hasStar && !served, `${site} page not served, no Star control (blocked/anti-bot): ${JSON.stringify(probe)}`);
  expect(probe.hasStar, `${site} Star control absent although the page WAS served - the ${site.toLowerCase()} nativeSelectors in supported-sites.ts drifted (selector drift, not a mount regression): ${JSON.stringify(probe)}`).toBe(true);
}

test.describe("private-page gate", () => {
  test("github: button mounts on a public repo, suppressed when marked private", async () => {
    const control = await session().context.newPage();
    try {
      await gotoSettled(control, GITHUB_PUBLIC, { tolerateNavError: true });
      const probe = await githubProbe(control);
      // A real repo view came back iff the visibility meta is present at all.
      requireStarControl(probe, probe.metaPublic !== null, "GitHub");
      expect(await waitForHostMount(control), "public repo should mount the picker").toBeGreaterThan(0);
    } finally {
      await control.close().catch(() => {});
    }

    const priv = await session().context.newPage();
    try {
      const countRewrites = await routeRewrittenDocument(priv, /github\.com\/[^/]+\/[^/?#]+/, (html) => html.replace(/(name="octolytics-dimension-repository_public"[^>]*content=")true(")/g, "$1false$2"));
      await gotoSettled(priv, GITHUB_PUBLIC, { tolerateNavError: true });
      const probe = await githubProbe(priv);
      // The rewrite must have landed AND the page must be a real repo view
      // (Star control present) - otherwise a 0-host result is meaningless.
      expect(countRewrites(), "visibility meta should have been rewritten").toBeGreaterThan(0);
      expect(probe.metaPublic, JSON.stringify(probe)).toBe("false");
      requireStarControl(probe, probe.metaPublic !== null, "GitHub");
      await expectNoHostMount(priv);
    } finally {
      await priv.close().catch(() => {});
    }
  });

  // Variant A of the GitHub heuristic: no visibility meta at all, the only
  // signal is the lock octicon in the repo header (older/partial server renders).
  test("github: suppressed when only the header lock octicon marks it private", async () => {
    const priv = await session().context.newPage();
    try {
      const countRewrites = await routeRewrittenDocument(priv, /github\.com\/[^/]+\/[^/?#]+/, (html) => html.replace(/<meta name="octolytics-dimension-repository_public"[^>]*>/g, "").replace(/(<div[^>]*id="repository-container-header"[^>]*>)/, '$1<svg class="octicon octicon-lock" aria-hidden="true"></svg>'));
      await gotoSettled(priv, GITHUB_PUBLIC, { tolerateNavError: true });
      const probe = await githubProbe(priv);
      expect(countRewrites(), "meta should be stripped and the lock injected").toBeGreaterThan(0);
      expect(probe.metaPublic, JSON.stringify(probe)).toBeNull();
      // The meta is stripped here by design, so the rewrite count is what proves a
      // real repo document came back.
      requireStarControl(probe, countRewrites() > 0, "GitHub");
      await expectNoHostMount(priv);
    } finally {
      await priv.close().catch(() => {});
    }
  });

  test("gitlab: button mounts on a public project, suppressed when marked private", async () => {
    const control = await session().context.newPage();
    try {
      await gotoSettled(control, GITLAB_PUBLIC, { tolerateNavError: true });
      const probe = await gitlabProbe(control);
      // A real project view came back iff the visibility icon rendered at all.
      requireStarControl(probe, probe.iconFragment !== null, "GitLab");
      expect(await waitForHostMount(control), "public project should mount the picker").toBeGreaterThan(0);
    } finally {
      await control.close().catch(() => {});
    }

    const priv = await session().context.newPage();
    try {
      const countRewrites = await routeRewrittenDocument(priv, /gitlab\.com\/[^/]+\/[^/?#]+/, (html) => html.replace(/\.svg#earth\b/g, ".svg#lock"));
      await gotoSettled(priv, GITLAB_PUBLIC, { tolerateNavError: true });
      const probe = await gitlabProbe(priv);
      expect(countRewrites(), "visibility icon should have been rewritten").toBeGreaterThan(0);
      expect(probe.iconFragment, JSON.stringify(probe)).toBe("lock");
      requireStarControl(probe, probe.iconFragment !== null, "GitLab");
      await expectNoHostMount(priv);
    } finally {
      await priv.close().catch(() => {});
    }
  });

  // Internal (`#shield`) visibility must gate like private, and the icon must be
  // readable through the `xlink:href` fallback GitLab still ships in places.
  test("gitlab: suppressed on an internal (#shield) icon read via xlink:href", async () => {
    const priv = await session().context.newPage();
    try {
      const countRewrites = await routeRewrittenDocument(priv, /gitlab\.com\/[^/]+\/[^/?#]+/, (html) => html.replace(/href="([^"]*\.svg)#earth\b/g, 'xlink:href="$1#shield'));
      await gotoSettled(priv, GITLAB_PUBLIC, { tolerateNavError: true });
      const probe = await gitlabProbe(priv);
      expect(countRewrites(), "visibility icon should have been rewritten").toBeGreaterThan(0);
      expect(probe.iconFragment, JSON.stringify(probe)).toBe("shield");
      requireStarControl(probe, probe.iconFragment !== null, "GitLab");
      await expectNoHostMount(priv);
    } finally {
      await priv.close().catch(() => {});
    }
  });
});
