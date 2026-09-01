// SPDX-License-Identifier: GPL-3.0-or-later
//
// Launching the browser the live-site suites drive, and the diagnostics a skip
// leaves behind. The launcher returns the generated profile dir rather than
// parking it in module state, so the suite's afterAll owns cleanup.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { launchRealisticContext, resolveExtensionPath, resolveUserDataDir } from "./browser-session";
import { extensionLaunchArgs, realisticClientEnabled } from "./launch-args";
import { debugEvidence, handleKnownInterstitials, isNoActionSurface, settleFullLoad, settlePage, waitForMountEvidence } from "./page-settle";
import type { MountEvidence, SupportedSiteScenario } from "./site-evidence";
import { dismissInterstitialsInitScript } from "./site-walls";

interface LaunchE2eOptions {
  locale?: string;
  incognito?: boolean;
  useGeneratedUserDataDir?: boolean;
}

interface E2eBrowserSession {
  context: BrowserContext;
  /** Non-null only when the launch minted a throwaway profile - the caller
   *  removes it, so a crashed run leaves at most one behind. */
  generatedUserDataDir: string | null;
}

export async function launchE2eBrowserSession(options: LaunchE2eOptions = {}): Promise<E2eBrowserSession> {
  const extensionPath = resolveExtensionPath();
  const { dir: userDataDir, generatedUserDataDir } = await resolveUserDataDir("e2e-user-data", { explicitDir: process.env.E2E_USER_DATA_DIR, useGenerated: options.useGeneratedUserDataDir });
  const realisticClient = realisticClientEnabled();
  const locale = options.locale ?? process.env.E2E_LOCALE ?? "en-US";
  const setBrowserLanguage = realisticClient || options.locale;

  const sessionContext = await launchRealisticContext(userDataDir, {
    headless: false,
    viewport: { width: 1366, height: 900 },
    screen: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    locale,
    timezoneId: process.env.E2E_TIMEZONE_ID ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(process.env.E2E_USER_AGENT ? { userAgent: process.env.E2E_USER_AGENT } : {}),
    ...(setBrowserLanguage ? { extraHTTPHeaders: { "Accept-Language": `${locale},en;q=0.9` } } : {}),
    args: extensionLaunchArgs({
      extensionPaths: [extensionPath],
      ...(setBrowserLanguage ? { locale, windowSize: "1366,900" } : {}),
      ...(options.incognito ? { incognito: true } : {}),
      realisticClient,
    }),
  });
  sessionContext.setDefaultTimeout(Number(process.env.E2E_DEFAULT_TIMEOUT_MS ?? 30_000));
  sessionContext.setDefaultNavigationTimeout(Number(process.env.E2E_NAV_TIMEOUT_MS ?? 60_000));
  if (realisticClient) {
    await sessionContext.addInitScript(realisticClientInitScript);
  }
  await sessionContext.addInitScript(dismissInterstitialsInitScript, { exposeUnwallHook: true, keepDialogsWithReactionHost: false });
  return { context: sessionContext, generatedUserDataDir };
}

// Runs in the page, so it closes over nothing from this module.
function realisticClientInitScript(): void {
  const defineGetter = <T>(owner: object, property: string, getter: () => T): void => {
    try {
      Object.defineProperty(owner, property, {
        configurable: true,
        get: getter,
      });
    } catch {
      // Ignore non-configurable browser properties.
    }
  };

  defineGetter(Navigator.prototype, "webdriver", () => false);
}

async function saveDiagnosticShot(page: Page, site: SupportedSiteScenario, label: string): Promise<void> {
  try {
    const info = test.info();
    const name = `skip-${site.site}-${label}`.replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
    const file = info.outputPath(`${name}.png`);
    await page.screenshot({ path: file, timeout: 8_000 });
    await info.attach(name, { path: file, contentType: "image/png" });
  } catch {
    /* diagnostic only - never let it mask the real skip */
  }
}

export async function skipWithShot(page: Page, site: SupportedSiteScenario, condition: boolean, reason: string, label: string): Promise<void> {
  if (!condition) return;
  await saveDiagnosticShot(page, site, label);
  test.skip(true, reason);
}

// A stale `mountKeyPattern` fails as an EMPTY matchingAnchorKeys - byte for byte what
// "nothing mounted" looks like. The keys the page actually derived, next to the pattern
// that rejected them, is what tells the two apart: facebook and gitlab are excluded from
// the registry's unit guard (src/shared/e2e-site-coverage.test.ts) because their keys need
// page state, so their patterns are the ones that can drift unnoticed.
export function keyMatchDiagnostic(site: SupportedSiteScenario, evidence: MountEvidence): string {
  return `derived keys ${JSON.stringify(evidence.anchorKeys.slice(0, 8))} vs mountKeyPattern ${site.mountKeyPattern}\n${debugEvidence(evidence)}`;
}

// The settle -> wall-skip -> assert-mounted ladder every navigation-owning leg repeats
// (site-injection's legs and glyph-size's opener - the per-suite copies had drifted).
// The caller owns its safeGoto/safeReload and passes the result as `navOk`. `phase`
// only chooses how the two skips read; `skipLabelPrefix` keeps each suite's screenshot
// names apart; `requireMatchingKeys: false` is for the caller that only needs a visible
// host (glyph-size), where a key assert would widen what that suite fails on.
export async function settleAndRequireMount(page: Page, site: SupportedSiteScenario, opts: { navOk: boolean; phase: "initial" | "after-signin"; skipLabelPrefix?: string; requireMatchingKeys?: boolean; expectHiddenNative?: boolean }): Promise<MountEvidence> {
  const afterSignIn = opts.phase === "after-signin";
  const prefix = opts.skipLabelPrefix ?? "";
  await settleFullLoad(page);
  await handleKnownInterstitials(page, site);
  await settlePage(page, site);
  // A social platform can block navigation outright (anti-bot HTTP error) -
  // there is then no page to test, so skip rather than fail on the raw error.
  const navReason = afterSignIn ? `Navigation blocked on ${site.site} after sign-in (anti-bot / HTTP error)` : `Navigation blocked on ${site.site} (anti-bot / HTTP error)`;
  await skipWithShot(page, site, !opts.navOk, navReason, afterSignIn ? `${prefix}nav-blocked-after-signin` : `${prefix}nav-blocked`);

  const evidence = await waitForMountEvidence(page, site, opts.expectHiddenNative ?? false);
  // Nothing to mount on - a wall URL, no visible native controls, or unambiguous interstitial
  // text (Threads keeps nav chrome that matches the broad native selectors). A mounted,
  // correctly-placed host always wins over all three.
  const surfaceReason = afterSignIn ? `No action surface after sign-in on ${site.site} (login wall / anti-bot): ${debugEvidence(evidence)}` : `No action surface on the logged-out ${site.site} page (login wall / anti-bot): ${debugEvidence(evidence)}`;
  await skipWithShot(page, site, isNoActionSurface(evidence), surfaceReason, afterSignIn ? `${prefix}no-action-surface-after-signin` : `${prefix}no-action-surface`);
  if (opts.requireMatchingKeys !== false) expect(evidence.matchingAnchorKeys, keyMatchDiagnostic(site, evidence)).not.toHaveLength(0);
  expect(evidence.visibleMatchingHostCount, debugEvidence(evidence)).toBeGreaterThan(0);
  return evidence;
}
