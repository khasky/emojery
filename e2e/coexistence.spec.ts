// SPDX-License-Identifier: GPL-3.0-or-later
//
// Coexistence with other content-manipulating extensions. Each
// configured extension gets its OWN browser launch with Emojery loaded
// next to it, and the trigger must still mount on a stable surface (GitHub) plus
// the ad-heavy ones a blocker or site tweaker actually rewrites (YouTube, Reddit).
//
// Configure via E2E_COEXT_SOURCES (`;`-separated GitHub release .zip/.crx
// URLs, Chrome Web Store URLs / 32-char ids, or local unpacked folders);
// E2E_COEXT_PATHS / E2E_COEXT_PATH (local folders) merge into the same list.
// Downloaded + unpacked (cached) by e2e/lib/coext-source.ts. Unset = skip, so
// the default suite downloads nothing.
//
// Always the MV3 build: current Chromium refuses to load MV2 unpacked (e.g.
// classic uBlock Origin / RES) - use the MV3 variant (uBlock Origin Lite, ...).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { configuredCoextSources, resolveCoextDir, sourceLabel } from "./lib/coext-source";
import * as ext from "./lib/extension";
import { DEEP_QUERY_ALL_SRC } from "./lib/probe-src";
import { wallReason } from "./lib/site-walls";
import { SUPPORTED_SITE_SCENARIOS } from "./supported-sites";

// Downloading + unpacking a Web Store .crx (tens of MB) on the first run needs
// more than the default per-test timeout; cached runs are fast.
const COEXT_TEST_TIMEOUT_MS = Number(process.env.E2E_COEXT_TEST_TIMEOUT_MS ?? 300_000);

// Count the extensions Chrome actually loaded, so "the other extension failed to
// load" cannot silently degrade this test into a plain single-extension run. Polled
// by the caller: chrome://extensions paints its cards asynchronously, and a
// one-shot read of a slow render blamed the co-extension for a rendering delay.
async function loadedExtensionCount(context: BrowserContext): Promise<number> {
  const page = await context.newPage();
  try {
    await page.goto("chrome://extensions/", { waitUntil: "domcontentloaded" });
    // chrome://extensions nests its cards in shadow roots, so this needs the same
    // shadow-piercing walk every other probe uses.
    return await page.evaluate<number>(`(() => {
      ${DEEP_QUERY_ALL_SRC}
      return deepQueryAll("extensions-item").length;
    })()`);
  } finally {
    await page.close().catch(() => {});
  }
}

// Logged-out surfaces a co-extension actually rewrites. GitHub is the wall-free
// hard assert; the others can serve a consent/anti-bot page with no action row
// at all - those legs are passed over by the nativeSurface guard instead of
// false-failing (a bare `continue` plus a `coext-surface-skipped` annotation,
// NOT the main suite's `test.skip` - see the note at the guard).
//
// The guard's selectors come from the shared registry, like private-pages.spec.ts:
// selector-drift.spec.ts asserts that same list is alive daily, which makes it
// the single canary. A private copy here would let a YouTube/Reddit restyle read
// as an anti-bot block instead of a failure - and it already had: the old copy
// listed `[data-testid='post-container']`, which the Reddit entry never had.
const registryNativeSurface = (urlKey: string): string =>
  SUPPORTED_SITE_SCENARIOS.filter((scenario) => scenario.urlKey === urlKey)
    .flatMap((scenario) => scenario.nativeSelectors)
    .join(", ");

const COEX_SURFACES: Array<{ name: string; url: () => string; nativeSurface: string | null }> = [
  { name: "github", url: () => ext.githubUrl(), nativeSurface: null },
  { name: "youtube", url: () => ext.envUrl("YOUTUBE"), nativeSurface: registryNativeSurface("YOUTUBE") },
  { name: "reddit", url: () => ext.envUrl("REDDIT_POST"), nativeSurface: registryNativeSurface("REDDIT_POST") },
];

async function assertMountsWithCoext(context: BrowserContext, coextLabel: string): Promise<void> {
  for (const surface of COEX_SURFACES) {
    // requireHost: false - a walled/blank surface is handled by the nativeSurface
    // guard below, which annotates and moves on instead of failing the case.
    const page: Page = await ext.openSite(context, surface.url(), { requireHost: false });
    try {
      if (surface.nativeSurface) {
        // Presence alone is not enough: an anti-bot response can ship the DOM
        // shell while painting a blank page (seen live on reddit) - require the
        // native surface to actually be VISIBLE before holding Emojery to it. A shell
        // can even keep layout-visible natives while rendering no real content
        // (seen live: blank reddit challenge page, clean URL, zero mounts) - so
        // also require the page to carry meaningful text before asserting.
        const nativeVisible = await page
          .locator(surface.nativeSurface)
          .filter({ visible: true })
          .count()
          .catch(() => 0);
        const bodyTextLength = await page.evaluate(() => (document.body?.innerText ?? "").trim().length).catch(() => 0);
        if (nativeVisible === 0 || bodyTextLength < 200) {
          // Anti-bot/blank shell: nothing to mount on. Continue rather than `test.skip` (see
          // the guard note above); the annotation is what leaves the trace in the report - with
          // the shared wall verdict naming WHICH wall, when one is recognizable.
          const wall = await wallReason(page);
          test.info().annotations.push({ type: "coext-surface-skipped", description: wall ? `${surface.name} - ${wall}` : surface.name });
          continue;
        }
      }
      await expect.poll(() => ext.visibleHostCount(page), { message: `the trigger should mount on ${surface.name} with "${coextLabel}" active`, timeout: 30_000 }).toBeGreaterThan(0);
    } finally {
      await page.close().catch(() => {});
    }
  }
}

const sources = configuredCoextSources();

if (sources.length === 0) {
  test("coexistence needs E2E_COEXT_SOURCES to have anything to load", () => {
    test.skip(true, "Set E2E_COEXT_SOURCES (`;`-separated GitHub .zip/.crx URLs, Chrome Web Store URLs / ids, or local unpacked folders - e.g. uBlock Origin Lite / AdBlock / Adblock Plus) to run the coexistence checks.");
  });
}

for (const source of sources) {
  // The title uses the pre-download label; the manifest name refines the in-test messages.
  test(`Emojery still mounts alongside ${sourceLabel(source)}`, async () => {
    test.setTimeout(COEXT_TEST_TIMEOUT_MS);
    test.skip(ext.isFirefoxRun(), "coexistence sources are Chrome MV3 builds loaded via Chrome CLI args - chromium-only");
    const { dir: coextDir, label } = await resolveCoextDir(source);

    const manifestVersion = (JSON.parse(await readFile(join(coextDir, "manifest.json"), "utf8")) as { manifest_version?: number }).manifest_version;
    expect(manifestVersion, `"${label}" is manifest v${manifestVersion}; current Chromium refuses MV2 unpacked - use the extension's MV3 build (e.g. uBlock Origin Lite instead of uBlock Origin).`).toBe(3);

    const userDataDir = await ext.makeRunProfileDir("coext-user-data");
    const context = await ext.launchRealisticContext(userDataDir, {
      headless: false,
      viewport: { width: 1366, height: 900 },
      args: ext.extensionLaunchArgs({ extensionPaths: [ext.resolveExtensionPath(), coextDir], windowSize: "1366,900" }),
    });
    context.setDefaultTimeout(Number(process.env.E2E_DEFAULT_TIMEOUT_MS ?? 30_000));
    context.setDefaultNavigationTimeout(Number(process.env.E2E_NAV_TIMEOUT_MS ?? 60_000));
    try {
      await expect
        .poll(() => loadedExtensionCount(context), {
          message: `both Emojery AND "${label}" must be loaded (a load error in chrome://extensions would make this a plain single-extension run)`,
          timeout: 15_000,
          intervals: [500],
        })
        .toBeGreaterThanOrEqual(2);
      await assertMountsWithCoext(context, label);
    } finally {
      await context.close().catch(() => {});
      await ext.removeProfileUnlessKept(userDataDir).catch(() => {});
    }
  });
}
