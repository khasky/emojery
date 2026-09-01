// SPDX-License-Identifier: GPL-3.0-or-later
//
// Launching the Chrome the autonomous specs drive, and tearing it down: where the
// built extension is, which profile dir a run gets (and who owns deleting it),
// and which browser binary actually runs.
//
// Knows nothing about Emojery's UI - it hands back a BrowserContext and stops.
// The extension's own pages are extension-pages.ts; the injected picker is
// reaction-surface.ts.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { type BrowserContext, chromium, firefox, type Page } from "@playwright/test";
import { EXTENSION_ROOT } from "./auth-signin";
import { markProfileOwner } from "./browser-reaper";
import { firefoxRunPrefs, geckoIdFromManifest, installTemporaryAddon } from "./firefox-addon";
import { extensionLaunchArgs } from "./launch-args";

// E2E_BROWSER=firefox switches every launcher below to Playwright's Firefox
// with the firefox build installed as a temporary add-on (see firefox-addon.ts).
// Anything else (or unset) is the Chromium path.
//
// THE canonical reason specs guard on this: Playwright Firefox's juggler neither
// navigates to nor TRACKS `moz-extension://` pages - even a tab the background
// opens via tabs.create never appears in context.pages() - so popup / auth /
// background surfaces are unreachable there and their specs skip. Content-script
// surfaces (placement, picker DOM, theming) run for real. Specs point here.
export function isFirefoxRun(): boolean {
  return process.env.E2E_BROWSER === "firefox";
}

// The one skip reason the specs guarding on isFirefoxRun cite, shared so the
// wording cannot drift between them.
export const FIREFOX_NO_EXTENSION_PAGES = "extension pages (popup/auth) are not reachable in Playwright Firefox - juggler does not attach to moz-extension:// tabs";

export interface Session {
  context: BrowserContext;
  userDataDir: string;
  /** Non-null when WE created a throwaway profile dir (caller may delete it). */
  generatedUserDataDir: string | null;
}

interface LaunchOptions {
  /** Reuse a specific profile dir across launches (restart-persistence tests). */
  userDataDir?: string;
  locale?: string;
  /** Keep the fresh-install onboarding tab (and stop the sweeper closing any page that
   *  navigates TO onboarding.html). Needed by a spec that asserts on that page - without
   *  it `page.goto(onboarding.html)` is closed under the spec a moment after it loads. */
  keepOnboardingTab?: boolean;
}

export function resolveExtensionPath(): string {
  // Defaults to the STAGING build, matching `.env.e2e.example` and the error
  // message below. The firefox run reads its OWN env var: `.env.e2e.example`
  // always supplies E2E_EXTENSION_PATH (it is loaded as public defaults), and
  // that value points at the chrome build.
  const extensionPath = isFirefoxRun() ? resolve(process.env.E2E_FIREFOX_EXTENSION_PATH ?? resolve(EXTENSION_ROOT, ".output", "firefox-mv2-staging")) : resolve(process.env.E2E_EXTENSION_PATH ?? resolve(EXTENSION_ROOT, ".output", "chrome-mv3-staging"));
  const manifestPath = resolve(extensionPath, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing built extension at ${manifestPath}. Build it first: "pnpm run build:staging${isFirefoxRun() ? ":firefox" : ""}".`);
  }
  return extensionPath;
}

// One throwaway browser profile under `.playwright/<name>/run-*`. Every suite
// that launches its own Chrome goes through this, so the leaked-profile cleanup
// rule (delete unless E2E_KEEP_PROFILE=1) has a single shape to honor. Except:
// an explicit profile (E2E_USER_DATA_DIR via resolveUserDataDir) never comes
// through here, so nothing prunes it - it is the user's to keep.
export async function makeRunProfileDir(name: string): Promise<string> {
  const base = resolve(EXTENSION_ROOT, ".playwright", name);
  await mkdir(base, { recursive: true });
  // A crashed or Ctrl-C'd run leaks its profile (the delete runs only on the
  // normal exit path), so prune siblings older than a day here - the one place
  // every suite passes through. Best-effort: a locked dir never blocks launch.
  // E2E_KEEP_PROFILE also shields a kept post-mortem profile from this prune,
  // same as removeProfileUnlessKept and the reaper honor it.
  const cutoffMs = Date.now() - 24 * 60 * 60 * 1000;
  if (process.env.E2E_KEEP_PROFILE !== "1") {
    try {
      for (const entry of await readdir(base)) {
        if (!entry.startsWith("run-")) continue;
        const dir = resolve(base, entry);
        const info = await stat(dir).catch(() => null);
        if (info && info.mtimeMs < cutoffMs) await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } catch {
      // unreadable base dir - fall through to the fresh mkdtemp
    }
  }
  const dir = await mkdtemp(resolve(base, "run-"));
  // Stamp the owning pid so lib/browser-reaper.ts can tell a browser this run
  // abandoned from one a CONCURRENT run is still using.
  await markProfileOwner(dir);
  return dir;
}

// The delete half of the leaked-profile rule (see makeRunProfileDir): a run's
// generated profile dir is removed unless E2E_KEEP_PROFILE=1 keeps it for a
// post-mortem.
export async function removeProfileUnlessKept(dir: string): Promise<void> {
  if (process.env.E2E_KEEP_PROFILE === "1") return;
  await rm(dir, { recursive: true, force: true });
}

// One resolver for every suite that launches its own Chrome: an explicit dir is
// reused as-is (no cleanup), otherwise a throwaway profile is minted and
// reported as generated, which is what makes the close helper delete it.
// `useGenerated` forces a throwaway even when an explicit dir is configured.
export async function resolveUserDataDir(name: string, opts: { explicitDir?: string | undefined; useGenerated?: boolean | undefined } = {}): Promise<{ dir: string; generatedUserDataDir: string | null }> {
  if (!opts.useGenerated && opts.explicitDir) {
    const dir = resolve(opts.explicitDir);
    await mkdir(dir, { recursive: true });
    return { dir, generatedUserDataDir: null };
  }
  const dir = await makeRunProfileDir(name);
  return { dir, generatedUserDataDir: dir };
}

type BrowserChannel = "chromium" | "chrome" | "msedge";

function browserExecutableOption(): { channel: BrowserChannel } | { executablePath: string } | Record<string, never> {
  const executablePath = process.env.E2E_BROWSER_EXECUTABLE_PATH ? resolve(process.env.E2E_BROWSER_EXECUTABLE_PATH) : undefined;
  if (executablePath) return { executablePath };
  const requested = process.env.E2E_CHROME_CHANNEL;
  if (requested === "chromium" || requested === "chrome" || requested === "msedge") {
    return { channel: requested };
  }
  return {};
}

interface RealisticContextOptions {
  /** Leave the fresh-install onboarding tab open - the onboarding spec asserts ON it. */
  keepOnboardingTab?: boolean;
}

// DEFAULTS to Playwright's bundled Chromium on purpose: recent real Chrome
// blocks CLI `--load-extension` (verified - channel:chrome loads zero service
// workers, so the extension id never resolves), which would break every
// extension spec. Target sites don't bot-block bundled Chromium anyway. An
// explicit E2E_CHROME_CHANNEL / E2E_BROWSER_EXECUTABLE_PATH is still honored.
//
// This is the ONE seam every launcher goes through, so E2E_BROWSER=firefox
// branches here: same profile-dir and teardown rules, Firefox launch + install.
export async function launchRealisticContext(userDataDir: string, baseOptions: Parameters<typeof chromium.launchPersistentContext>[1], opts: RealisticContextOptions = {}): Promise<BrowserContext> {
  if (isFirefoxRun()) return launchFirefoxContext(userDataDir, baseOptions);
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...browserExecutableOption(),
    ...baseOptions,
  });
  if (!opts.keepOnboardingTab) suppressOnboardingTab(context);
  return context;
}

// Every fresh profile fires onInstalled("install"), so background/install.ts
// opens onboarding.html into the spec's tab set - close it on sight. Chromium
// only: on the firefox run the temporary-addon install skips the onboarding tab
// (and juggler would not surface a moz-extension page anyway).
function suppressOnboardingTab(context: BrowserContext): void {
  const closeWhenOnboarding = (page: Page): void => {
    // The tab is created before its URL commits; waitForURL covers both the
    // already-there and the about-to-navigate case. A spec page that never
    // becomes onboarding.html times the wait out and is left alone.
    void page
      .waitForURL(/^chrome-extension:\/\/[^/]+\/onboarding\.html/, { timeout: 10_000 })
      .then(() => page.close())
      .catch(() => {});
  };
  for (const page of context.pages()) closeWhenOnboarding(page);
  context.on("page", closeWhenOnboarding);
}

// The Firefox counterpart of the Chromium launch above. Callers still hand in
// Chrome CLI args (extensionLaunchArgs) - those are dropped here and replaced
// by the debugger-server arg the temporary-addon install needs; the build to
// load always comes from resolveExtensionPath (no caller loads anything else on
// firefox - the coexistence suite, which loads extras, is chromium-only).
// E2E_CHROME_CHANNEL / E2E_BROWSER_EXECUTABLE_PATH are ignored on purpose:
// Playwright only drives its own patched Firefox build, never a stock install.
async function launchFirefoxContext(userDataDir: string, baseOptions: Parameters<typeof chromium.launchPersistentContext>[1]): Promise<BrowserContext> {
  const extensionPath = resolveExtensionPath();
  // `args`/`isMobile` are chromium-only (Firefox rejects isMobile), the rest of
  // the base options (viewport, locale, timezone, headers, UA) port as-is.
  const { args: _chromeArgs, isMobile: _isMobile, ...portable } = baseOptions ?? {};
  const port = await freePort();
  const context = await firefox.launchPersistentContext(userDataDir, {
    ...portable,
    args: ["-start-debugger-server", String(port)],
    firefoxUserPrefs: {
      ...firefoxRunPrefs({ geckoId: geckoIdFromManifest(extensionPath), locale: baseOptions?.locale }),
      ...baseOptions?.firefoxUserPrefs,
    },
  });
  try {
    await installTemporaryAddon(port, extensionPath);
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
  return context;
}

// An OS-assigned free port for the debugger server. workers=1 keeps launches
// sequential, so the tiny close-to-use window cannot race another suite.
async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a port for the Firefox debugger server"));
        return;
      }
      server.close(() => resolvePort(address.port));
    });
  });
}

export async function launchSession(options: LaunchOptions = {}): Promise<Session> {
  const extensionPath = resolveExtensionPath();
  const { dir: userDataDir, generatedUserDataDir } = await resolveUserDataDir("authed-user-data", { explicitDir: options.userDataDir });
  const locale = options.locale ?? process.env.E2E_LOCALE ?? "en-US";

  const baseOptions = {
    headless: false as const,
    viewport: { width: 1366, height: 900 },
    locale,
    // realisticClient is forced on here: these sessions drive real sites and have
    // never been opted out of the anti-detection flag.
    args: extensionLaunchArgs({ extensionPaths: [extensionPath], locale, windowSize: "1366,900", realisticClient: true }),
  };
  const context = await launchRealisticContext(userDataDir, baseOptions, options.keepOnboardingTab ? { keepOnboardingTab: true } : {});
  context.setDefaultTimeout(Number(process.env.E2E_DEFAULT_TIMEOUT_MS ?? 30_000));
  context.setDefaultNavigationTimeout(Number(process.env.E2E_NAV_TIMEOUT_MS ?? 60_000));
  return { context, userDataDir, generatedUserDataDir };
}

// Also the close helper for the specs that launch their own session shape: only
// the context and the generated-dir marker matter for teardown.
export async function closeSession(session: Pick<Session, "context" | "generatedUserDataDir">, opts: { keepDir?: boolean } = {}): Promise<void> {
  await session.context.close().catch(() => {});
  if (!opts.keepDir && session.generatedUserDataDir) {
    await removeProfileUnlessKept(session.generatedUserDataDir);
  }
}
