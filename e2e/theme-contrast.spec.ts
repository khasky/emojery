// SPDX-License-Identifier: GPL-3.0-or-later
//
// Black-box theme/contrast checks on REAL supported sites (no HTML fixtures): the trigger
// blends into each site's local action surface and stays legible in whatever theme the
// live site renders. Every color expectation is RELATIVE and derived from the page at
// runtime - the trigger color tracks the extension's computed `--khasky-emojery-site-fg`,
// and that color clears a WCAG contrast threshold against the background it actually
// renders on - so the test survives site restyles.
//
// Theme coverage: light/dark are forced via Playwright `emulateMedia`. Sites that follow
// the system scheme when logged out (YouTube, GitHub, Instagram, Threads, GitLab)
// re-render for real; setting-based Amazon only exposes its logged-out default, so it runs
// in light only. Each run logs its measurement so the re-theming behavior is observable.

import { type BrowserContext, type ElementHandle, expect, type Page, type TestInfo, test } from "@playwright/test";
import { authConfigured, clearReaction, envUrl, extensionLaunchArgs, isFirefoxRun, launchRealisticContext, makeRunProfileDir, openPickerTray, realisticClientEnabled, removeProfileUnlessKept, resolveExtensionPath, signIn } from "./lib/extension";
import { gotoSettled } from "./lib/page-settle";
import { pollForValue } from "./lib/picker-probes";
import { DEEP_QUERY_ALL_SRC } from "./lib/probe-src";
import { GRID_ITEM_SELECTOR } from "./lib/selectors";
import { clickAmazonContinueShopping, dismissInterstitialsInitScript, interstitialTextRe, wallReason } from "./lib/site-walls";

type Scheme = "light" | "dark";

// Minimum WCAG contrast ratio between the trigger text and the effective
// background it renders on. 3.0 = WCAG AA for large/UI text; override per run.
const MIN_CONTRAST = Number(process.env.E2E_MIN_CONTRAST ?? 3);
// Per-channel tolerance when checking the trigger color tracks `--khasky-emojery-site-fg`.
const FG_TOLERANCE = Number(process.env.E2E_FG_TOLERANCE ?? 12);
// How long the active phase waits for a picked reaction to reach the trigger.
// It covers a full vote round-trip through the background and the server, which
// under load stretches well past the picker's own optimistic paint.
const ACTIVE_STATE_TIMEOUT_MS = Number(process.env.E2E_ACTIVE_STATE_TIMEOUT_MS ?? 45_000);

interface ThemeScenario {
  site: string;
  label: string;
  url: string;
  schemes: Scheme[];
  scrollSteps: number[];
}

interface TriggerMeasurement {
  siteFg: [number, number, number] | null;
  triggerColor: [number, number, number];
  triggerColorText: string;
  effectiveBg: [number, number, number];
  contrast: number;
  active: string | null;
}

const scenarios: ThemeScenario[] = [
  // System-following sites: exercise both themes for real.
  {
    site: "youtube",
    label: "YouTube watch",
    url: envUrl("YOUTUBE"),
    schemes: ["light", "dark"],
    scrollSteps: [0, 400, 800, 0],
  },
  {
    site: "github",
    label: "GitHub repo",
    url: envUrl("GITHUB"),
    schemes: ["light", "dark"],
    scrollSteps: [0, 300, 700, 0],
  },
  {
    site: "gitlab",
    label: "GitLab project",
    url: envUrl("GITLAB"),
    schemes: ["light", "dark"],
    scrollSteps: [0, 300, 700, 0],
  },
  {
    site: "instagram",
    label: "Instagram post",
    url: envUrl("INSTAGRAM_POST"),
    schemes: ["light", "dark"],
    scrollSteps: [0, 300, 700, 0],
  },
  {
    site: "threads",
    label: "Threads post",
    url: envUrl("THREADS_POST"),
    schemes: ["light", "dark"],
    scrollSteps: [0, 400, 900, 0],
  },
  // Setting-based / light-only surface: a distinct colored-control surface.
  // (X is covered for both themes in site-injection.spec.ts instead - its
  // logged-out action row, while now system-following, is unreliable to reveal
  // in this contrast harness under automation.)
  {
    site: "amazon",
    label: "Amazon product",
    url: envUrl("AMAZON_US"),
    schemes: ["light"],
    scrollSteps: [0, 300, 700, 0],
  },
];

let context: BrowserContext;
let generatedUserDataDir: string | null = null;

test.beforeAll(async () => {
  const extensionPath = resolveExtensionPath();
  generatedUserDataDir = await makeRunProfileDir("theme-contrast-user-data");
  const realistic = realisticClientEnabled();
  const locale = process.env.E2E_LOCALE ?? "en-US";

  context = await launchRealisticContext(generatedUserDataDir, {
    headless: false,
    viewport: { width: 1366, height: 900 },
    screen: { width: 1366, height: 900 },
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    locale,
    timezoneId: process.env.E2E_TIMEZONE_ID ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    // Spread rather than assign: an unset E2E_USER_AGENT must OMIT the key, not
    // pass `undefined` (Playwright's option type rejects it under
    // exactOptionalPropertyTypes, and an explicit undefined is not the default).
    ...(process.env.E2E_USER_AGENT ? { userAgent: process.env.E2E_USER_AGENT } : {}),
    extraHTTPHeaders: { "Accept-Language": `${locale},en;q=0.9` },
    args: extensionLaunchArgs({ extensionPaths: [extensionPath], locale, windowSize: "1366,900", realisticClient: realistic }),
  });
  context.setDefaultTimeout(Number(process.env.E2E_DEFAULT_TIMEOUT_MS ?? 30_000));
  context.setDefaultNavigationTimeout(Number(process.env.E2E_NAV_TIMEOUT_MS ?? 60_000));
  if (realistic) {
    await context.addInitScript(() => {
      try {
        Object.defineProperty(Navigator.prototype, "webdriver", {
          configurable: true,
          get: () => false,
        });
      } catch {
        // Ignore non-configurable browser properties.
      }
    });
  }
  // Hide login/signup walls (DOM-only) so the action row underneath is reachable
  // on Instagram/Threads. Does not log in or touch accounts.
  await context.addInitScript(dismissInterstitialsInitScript, { exposeUnwallHook: false, keepDialogsWithReactionHost: true });

  // The active-phase check needs a reaction to stick, and only a signed-in
  // Emojery user gets an active trigger - sign in when the test account is
  // configured. Emojery auth is independent of the host platforms, which stay
  // logged out. Firefox cannot sign in (auth.html is unreachable from
  // Playwright), so there the active phase self-reports "not measured".
  if (authConfigured() && !isFirefoxRun()) {
    await signIn(context);
  }
});

test.afterAll(async () => {
  await context?.close().catch(() => {});
  if (generatedUserDataDir) await removeProfileUnlessKept(generatedUserDataDir);
});

for (const scenario of scenarios) {
  for (const scheme of scenario.schemes) {
    test(`${scenario.site} (${scheme}): trigger blends into the live action surface and stays legible`, async () => {
      // Real-site navigation + two measurement phases + screenshots outgrow the
      // default budget, and under load the "trace recording" fixture setup eats
      // into it before the test body starts. 3x leaves room without masking a hang.
      test.slow();
      // test.info() instead of the `({}, testInfo)` callback params: the empty
      // fixture destructuring trips biome's noEmptyPattern.
      const testInfo = test.info();
      const page = await context.newPage();
      try {
        await page.emulateMedia({ colorScheme: scheme });
        const navOk = await openSite(page, scenario);
        // A logged-out social site can hard-block the automated browser: an
        // anti-bot HTTP error on navigation, or a redirect to its login wall.
        // There is then no post - and no trigger - to measure, so skip rather
        // than false-fail (login-free sites still fail loudly: a real outage is
        // a real problem, and retries cover transient blips).
        test.skip(!navOk, `Navigation blocked on ${scenario.label} (anti-bot / HTTP error)`);
        const hasTrigger = await waitForVisibleTrigger(page, scenario);
        if (!hasTrigger) {
          const blocked = await blockedReason(page, scenario);
          test.skip(blocked !== null, `No action surface on ${scenario.label} - ${blocked}`);
          throw new Error(`No visible Emojery trigger on ${scenario.label} (${page.url()})`);
        }

        const idle = await measureTrigger(page);
        logMeasurement(scenario, scheme, "idle", idle);
        assertLegible(idle, scenario, scheme, "idle");
        await attachScreenshot(page, testInfo, `${scenario.site}-${scheme}-idle`);

        const pickFailure = await pickFirstReaction(page);
        if (!pickFailure) {
          const active = await measureTrigger(page);
          logMeasurement(scenario, scheme, "active", active);
          expect(active.active, `${scenario.label} (${scheme}): trigger should be active after picking`).toBe("true");
          assertLegible(active, scenario, scheme, "active");
          await attachScreenshot(page, testInfo, `${scenario.site}-${scheme}-active`);
        } else {
          // No pick landed. Unconfigured is the expected, documented path - and so
          // is firefox, where beforeAll never signs in (auth.html is unreachable
          // from Playwright). Configured => a pick MUST land: an annotation is not
          // a skip and not a failure, so without this assert the whole active phase
          // used to pass on a broken picker. Surface the reason in the log and the
          // report next to the measurements.
          const reason = isFirefoxRun() ? "firefox run: cannot sign in (auth.html unreachable from Playwright)" : authConfigured() ? `signed in, but ${pickFailure}` : "no Emojery test account configured (E2E_AUTH_EMAIL + E2E_AUTH_OTP)";
          console.log(`[theme] ${scenario.site} ${scheme}/active: not measured - ${reason}`);
          testInfo.annotations.push({ type: "active-phase-not-measured", description: `${scenario.label} (${scheme}): ${reason}` });
          expect(authConfigured() && !isFirefoxRun(), `${scenario.label} (${scheme}/active): ${reason}`).toBe(false);
        }
      } finally {
        // Best-effort: these are shared PUBLIC targets, so the run's account should not be
        // left holding a reaction on them - the sibling authed specs clear theirs too. Only
        // after the LAST scheme (the dark pass measures the reaction the light pass left)
        // and only when one is actually held, so a walled scenario doesn't pay the picker's
        // focus timeout for nothing.
        const lastScheme = scenario.schemes[scenario.schemes.length - 1];
        if (scheme === lastScheme && (await triggerState(page).catch(() => ({ visible: false, active: false }))).active) {
          await clearReaction(page).catch(() => {});
        }
        await page.close().catch(() => {});
      }
    });
  }
}

function logMeasurement(scenario: ThemeScenario, scheme: Scheme, phase: string, m: TriggerMeasurement): void {
  const fg = m.siteFg ? `rgb(${m.siteFg.join(",")})` : "unset";
  console.log(`[theme] ${scenario.site} ${scheme}/${phase}: --khasky-emojery-site-fg=${fg} ` + `trigger=${m.triggerColorText} bg=rgb(${m.effectiveBg.join(",")}) ` + `contrast=${m.contrast.toFixed(2)}`);
}

function assertLegible(m: TriggerMeasurement, scenario: ThemeScenario, scheme: Scheme, phase: string): void {
  // The native-look core invariant: the trigger text is legible on whatever it
  // renders on. (The extension itself targets >= 4.5; 3.0 is a safe floor.)
  expect(m.contrast, `${scenario.label} (${scheme}/${phase}): contrast ${m.contrast.toFixed(2)} < ${MIN_CONTRAST} ` + `(text ${m.triggerColorText} on rgb(${m.effectiveBg.join(",")}))`).toBeGreaterThanOrEqual(MIN_CONTRAST);

  // When the extension sampled a surface color, the trigger must follow it
  // (proves it blends with the site rather than using a generic color).
  if (m.siteFg) {
    for (const i of [0, 1, 2] as const) {
      expect(Math.abs(m.triggerColor[i] - m.siteFg[i]), `${scenario.label} (${scheme}/${phase}): trigger color ${m.triggerColorText} should track ` + `--khasky-emojery-site-fg rgb(${m.siteFg.join(",")})`).toBeLessThanOrEqual(FG_TOLERANCE);
    }
  }
}

// Returns false when navigation itself was blocked (anti-bot HTTP error such as
// Threads' ERR_HTTP_RESPONSE_CODE_FAILURE) so the caller can skip the scenario.
async function openSite(page: Page, scenario: ThemeScenario): Promise<boolean> {
  const navOk = await gotoSettled(page, scenario.url, { tolerateNavError: true });
  if (scenario.site === "amazon") await clickAmazonContinueShopping(page, scenario.url);
  // Cleared BEFORE and AFTER the settle, the same way selector-drift.spec.ts does
  // it: a consent or ads dialog can render a second after `load`, so one early
  // pass misses it and every colour then samples the overlay instead of the page.
  await dismissInterstitials(page);
  await page.waitForTimeout(1_500);
  await dismissInterstitials(page);
  return navOk;
}

// True for the logged-out social platforms that anti-bot-block automated
// browsers (login walls, error interstitials); only these are eligible to skip.
const SOCIAL_SITES = new Set(["instagram", "threads"]);
function isSocialSite(scenario: ThemeScenario): boolean {
  return SOCIAL_SITES.has(scenario.site);
}

// Body-text signals of a wall, kept social-only (see below). Named so the skip can quote
// the sentence that matched instead of just the URL - "log in to" legitimately appears on
// a normally-served Instagram/Threads post page, so knowing WHICH phrase fired is what
// tells a real block from a copy collision.
//
// Twin of `hasInterstitialText` in lib/page-settle.ts: both compose the shared phrase set
// in lib/site-walls.ts, so a phrase added there reaches both. `log in to|sign up to` stays
// a LOCAL extra - safe only for this social-only check, never for the page-settle twin
// that runs on every site.
const WALL_TEXT = interstitialTextRe("log in to", "sign up to");

// The page served a login wall / anti-bot interstitial instead of the post, so
// there's no trigger to measure, so skip (not fail). Returns the reason (for the
// skip message) or null. The shared wallReason (URL gate + exact wall sentences)
// counts for ANY site (a CAPTCHA can hit YouTube); the looser body-text signal
// stays social-only so ordinary content words (Amazon "temporarily unavailable")
// can't skip a login-free site whose missing trigger would be a real regression.
async function blockedReason(page: Page, scenario: ThemeScenario): Promise<string | null> {
  const wall = await wallReason(page);
  if (wall) return wall;
  // Amazon's anti-bot can bounce the product request to the bare homepage
  // (final URL https://www.amazon.com/) - no wall URL token and no wall sentence
  // rendered, so wallReason misses it. We asked for a /dp/ product; if the final
  // URL isn't a product page, the product (and its trigger) was never served, so
  // skip rather than false-fail.
  if (scenario.site === "amazon") return amazonRedirectedAwayFromProduct(page, scenario) ? `redirected away from the product page: ${page.url()}` : null;
  if (!isSocialSite(scenario)) return null;
  const text = await page.evaluate(() => (document.body?.textContent ?? "").replace(/\s+/g, " ").slice(0, 4000)).catch(() => "");
  const hit = text.match(WALL_TEXT);
  return hit ? `login wall / interstitial text: "${hit[0]}" (${page.url()})` : null;
}

// Amazon served an anti-bot page instead of the requested product: the final URL
// left the product path (bare homepage or a robot-check). Guarded on the fixture
// actually being a product URL, so a genuinely missing trigger on a real product
// page still fails loudly. A real product page carries /dp/ or /gp/product/.
function amazonRedirectedAwayFromProduct(page: Page, scenario: ThemeScenario): boolean {
  let finalUrl: URL;
  let wanted: URL;
  try {
    finalUrl = new URL(page.url());
    wanted = new URL(scenario.url);
  } catch {
    return false;
  }
  const isProductPath = (path: string): boolean => /\/dp\/|\/gp\/(product|aw\/d)\//i.test(path);
  if (!isProductPath(wanted.pathname)) return false;
  if (!/amazon\./i.test(finalUrl.hostname)) return true;
  return !isProductPath(finalUrl.pathname);
}

// Returns true once a visible trigger is found; false if none appears within the
// budget OR the page is a social login wall / anti-bot block (bail early so the
// caller can skip well within the test timeout).
async function waitForVisibleTrigger(page: Page, scenario: ThemeScenario): Promise<boolean> {
  const deadline = Date.now() + Number(process.env.E2E_SITE_TIMEOUT_MS ?? 70_000);
  while (Date.now() < deadline) {
    for (const y of scenario.scrollSteps) {
      await page.evaluate((top) => window.scrollTo({ top, behavior: "auto" }), y);
      // Poll interval, bounded by `deadline` above: the trigger mounts lazily once the row
      // reaches the viewport, so each scroll step needs time to settle before the read.
      await page.waitForTimeout(800);
      if ((await triggerState(page)).visible) return true;
    }
    await dismissInterstitials(page);
    if (await blockedReason(page, scenario)) return false;
  }
  return false;
}

// Source-string form (see lib/probe-src.ts): an evaluate callback is serialized
// and cannot close over an imported function, so the canonical walk - the one
// with the `seen` dedupe the local copies lacked - can only be shared this way.
// ONE walk feeds all three trigger reads below; they used to be three copies
// differing only in what they returned.
const PAINTED_TRIGGERS_SRC = `const paintedTriggers = () => {
  const out = [];
  for (const host of deepQueryAll(".khasky-emojery-host")) {
    const trigger = host.shadowRoot?.querySelector(".khasky-emojery-trigger, .khasky-emojery-counter");
    if (!trigger) continue;
    const r = trigger.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) out.push({ host, trigger });
  }
  return out;
};`;

function triggerState(page: Page): Promise<{ visible: boolean; active: boolean }> {
  return page.evaluate<{ visible: boolean; active: boolean }>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    ${PAINTED_TRIGGERS_SRC}
    const painted = paintedTriggers();
    return {
      visible: painted.length > 0,
      active: painted[0]?.trigger.getAttribute("data-active") === "true",
    };
  })()`);
}

// The first host whose shadow trigger paints a box, through the same walk.
// Resolved as an element HANDLE so measureTrigger's colour math stays a
// type-checked callback instead of re-declaring the walk inline.
async function firstPaintedTriggerHost(page: Page) {
  const handle = await page.evaluateHandle<HTMLElement | null>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    ${PAINTED_TRIGGERS_SRC}
    return paintedTriggers()[0]?.host ?? null;
  })()`);
  const el = handle.asElement();
  if (!el) await handle.dispose().catch(() => {});
  return el;
}

async function measureTrigger(page: Page): Promise<TriggerMeasurement> {
  const hostHandle = await firstPaintedTriggerHost(page);
  if (!hostHandle) throw new Error("no visible Emojery trigger");
  try {
    return await measureTriggerHost(page, hostHandle);
  } finally {
    await hostHandle.dispose().catch(() => {});
  }
}

function measureTriggerHost(page: Page, hostHandle: ElementHandle<HTMLElement>): Promise<TriggerMeasurement> {
  return page.evaluate((host) => {
    type Rgba = [number, number, number, number];
    const parse = (raw: string | null): Rgba | null => {
      if (!raw) return null;
      const s = raw.trim();
      if (s.startsWith("#")) {
        let h = s.slice(1);
        if (h.length === 3)
          h = h
            .split("")
            .map((c) => c + c)
            .join("");
        if (h.length < 6) return null;
        return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16), 1];
      }
      const m = s.match(/rgba?\(([^)]+)\)/i);
      if (!m) return null;
      const p = m[1]!
        .split(/[,/\s]+/)
        .filter(Boolean)
        .map((x) => parseFloat(x));
      if (p.length < 3) return null;
      return [p[0]!, p[1]!, p[2]!, p.length > 3 ? p[3]! : 1];
    };
    const over = (top: Rgba, bottom: number[]): number[] => {
      const a = top[3];
      return [Math.round(top[0] * a + bottom[0]! * (1 - a)), Math.round(top[1] * a + bottom[1]! * (1 - a)), Math.round(top[2] * a + bottom[2]! * (1 - a))];
    };
    const luminance = (c: number[]): number => {
      const f = (v: number): number => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
    };
    const contrast = (a: number[], b: number[]): number => {
      const l1 = luminance(a);
      const l2 = luminance(b);
      const hi = Math.max(l1, l2);
      const lo = Math.min(l1, l2);
      return (hi + 0.05) / (lo + 0.05);
    };
    const effectiveBg = (el: Element): number[] => {
      const layers: Rgba[] = [];
      let node: Element | null = el;
      while (node) {
        const c = parse(getComputedStyle(node).backgroundColor);
        if (c && c[3] > 0) {
          layers.push(c);
          if (c[3] >= 1) break;
        }
        const root = node.getRootNode();
        node = node.parentElement ?? (root instanceof ShadowRoot ? (root.host as Element) : null);
      }
      // Match the extension's own canvas fallback: when nothing opaque is found
      // up the chain, the page's effective canvas is dark in dark mode, not white.
      const darkCanvas = window.matchMedia("(prefers-color-scheme: dark)").matches;
      let base: number[] = darkCanvas ? [24, 25, 26] : [255, 255, 255];
      for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i]!, base);
      return base;
    };

    const trigger = host.shadowRoot?.querySelector<HTMLElement>(".khasky-emojery-trigger, .khasky-emojery-counter");
    if (!trigger) throw new Error("no visible Emojery trigger");

    const cs = getComputedStyle(trigger);
    const color = parse(cs.color) ?? [0, 0, 0, 1];
    const eff = effectiveBg(trigger);
    const siteFg = parse(host.style.getPropertyValue("--khasky-emojery-site-fg"));

    return {
      siteFg: siteFg ? [siteFg[0], siteFg[1], siteFg[2]] : null,
      triggerColor: [color[0], color[1], color[2]],
      triggerColorText: cs.color,
      effectiveBg: eff,
      contrast: contrast([color[0], color[1], color[2]], eff),
      active: trigger.getAttribute("data-active"),
    } as TriggerMeasurement;
  }, hostHandle);
}

// `null` means a reaction is now on the trigger; a string names the stage that
// stopped short. Four different causes used to collapse into one "the picker
// never opened or the active state never landed" sentence, which is what made a
// red active phase unreadable without a rerun.
async function pickFirstReaction(page: Page): Promise<string | null> {
  // A reaction sticks only for a signed-in user (the test account from beforeAll).
  // The light pass already picked on this target (both schemes share one context and
  // account), so the trigger is active - measure that instead of toggling it back off.
  //
  // "The trigger" is paintedTriggers()[0] throughout - the one openPickerTray focuses
  // and measureTrigger measures. It used to be "any painted trigger" here and in the
  // post-pick poll, which is a different button on a page carrying several targets:
  // an Amazon product page mounts the product AND its carousel items, an earlier spec
  // left a reaction on one of them, so this returned "already active" without picking
  // and the assertion then read data-active="false" off the untouched first trigger.
  if ((await triggerState(page)).active) return null;
  // The tray opens via the KEYBOARD (focus + Space), not a coordinate click: the
  // trigger keeps re-measuring itself for ~2.4s after mount and Playwright's
  // coordinate mapping ignores CSS `zoom`, so a click aimed at a measured centre
  // lands beside the button and the grid "never appears" (see openPickerTray).
  // The grid-item click below stays a real mouse event - the picker ignores
  // untrusted ones, so an in-page .click() is dropped without a trace.
  const trayOpened = await openPickerTray(page).then(
    () => true,
    () => false,
  );
  if (!trayOpened) return "the trigger never took keyboard focus";

  const findOverlay = `(() => {
    ${DEEP_QUERY_ALL_SRC}
    return deepQueryAll('.khasky-emojery-overlay-host')[0] ?? null;
  })()`;

  const opened = await page
    .waitForFunction(`!!(${findOverlay})?.shadowRoot?.querySelector('.khasky-emojery-grid-item')`, undefined, { timeout: 8_000 })
    .then(() => true)
    .catch(() => false);
  if (!opened) return "the picker grid never rendered";

  // Through a locator, not raw page coordinates: a coordinate click hits
  // whatever paints on top at that point, and on the feed sites the popover
  // region is overlaid by the site's own layers - the click then lands on the
  // site and no reaction is ever sent. The keyboard fallback is the trusted path
  // for the case Playwright's own hit-target check can't clear (same reason as
  // the option click in lib/picker-probes.ts).
  const option = page.locator(GRID_ITEM_SELECTOR).filter({ visible: true }).first();
  await option.click({ timeout: 5_000 }).catch(async () => {
    await option.focus();
    await page.keyboard.press(" ");
  });

  // Polled, not waitForFunction: `data-active` flips only once the vote has been
  // through the background and the server (measured live - the trigger still read
  // data-active="false" the instant after a click that had already bumped the
  // count), and a watch page re-navigates on its own while that is in flight. A
  // waitForFunction dies with its execution context on that navigation and
  // reported the still-pending pick as "never landed" seconds into its window;
  // re-reading across the navigation waits out the round-trip instead.
  const active = await pollForValue(
    () =>
      page
        .evaluate<boolean>(`(() => {
          ${DEEP_QUERY_ALL_SRC}
          ${PAINTED_TRIGGERS_SRC}
          return paintedTriggers()[0]?.trigger.getAttribute("data-active") === "true";
        })()`)
        .catch(() => false),
    (flipped) => flipped,
    ACTIVE_STATE_TIMEOUT_MS,
  );
  return active ? null : "the clicked reaction never turned the trigger active";
}

// Consent/ads dialogs only. Amazon's throttle page is deliberately NOT in this list:
// its button label also appears in a healthy product page's out-of-stock widget, so
// matching the bare phrase clicks the page off-product. clickAmazonContinueShopping
// (lib/site-walls.ts) is the one that presses it, gated on the full throttle sentence,
// and it runs before this does.
async function dismissInterstitials(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const re = /^(accept all|reject all|i agree|agree|got it|no thanks|not now|dismiss|close|allow all|accept|reject)$/i;
      const candidates = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"] button, [aria-modal="true"] button, [role="dialog"] [role="button"], ' + "button[aria-label], tp-yt-paper-button, ytd-button-renderer button, form button"));
      for (const el of candidates) {
        const label = (el.getAttribute("aria-label") || el.textContent || "").replace(/\s+/g, " ").trim();
        if (re.test(label)) {
          try {
            el.click();
          } catch {
            // Ignore detached/stale nodes.
          }
        }
      }
      for (const el of [document.documentElement, document.body]) {
        el?.style.setProperty("overflow", "auto", "important");
      }
    })
    .catch(() => {});
}

async function attachScreenshot(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const path = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path, fullPage: false }).catch(() => {});
  await testInfo.attach(label, { path, contentType: "image/png" }).catch(() => {});
}
