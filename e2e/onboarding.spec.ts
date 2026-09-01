// SPDX-License-Identifier: GPL-3.0-or-later
//
// The fresh-install onboarding path, end to end on a real browser: the onboarding
// tab and toolbar dot the install event owes (and their restart behavior), the
// Try-it-live deep link landing on the live repo page with the picker
// auto-opened, the one-time coach-mark on the first organically-visited
// trigger, and - behind the OTP credentials - the whole first-reaction journey
// that retires the dot.
//
// Every test launches its OWN throwaway profile - onboarding is a
// once-per-install path, so a shared context would consume it for the rest.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
// The shipped CTA target itself, so the assert cannot drift from the page. It is
// asserted ONCE, as an href - nothing here navigates to it: the target can be
// unreachable from a runner, and an onboarding regression must not be reported
// as a 404 on someone's repository. The literal behind it is pinned by
// onboarding.browser.test.tsx.
import { TRY_IT_LIVE_URL } from "../src/shared/tracking-links";
import { closeSession, isFirefoxRun, launchRealisticContext, makeRunProfileDir, resolveExtensionPath } from "./lib/browser-session";
import { ensureSignedOut, firstServiceWorker } from "./lib/extension-pages";
import { extensionLaunchArgs } from "./lib/launch-args";
import { pollForValue } from "./lib/picker-probes";
import { signInTestAccount } from "./lib/popup-probes";
import { GRID_ITEM_SELECTOR, HOST_SELECTOR, SEARCH_INPUT_SELECTOR, TRIGGER_SELECTOR } from "./lib/selectors";
import { authConfigured, envUrl, otpSkipReason } from "./lib/test-config";

// The onboarding tab itself never opens there (temporary add-on installs skip it by design),
// and extension pages are unreachable anyway - see isFirefoxRun().
const FIREFOX_NO_ONBOARDING = "Firefox: temporary add-on installs skip the onboarding tab, and Playwright cannot open extension pages";

// Every leg that needs a REAL supported page runs on the shared GitHub fixture
// instead (E2E_URL_GITHUB), so these tests hold whatever the CTA points at.
const REPO_PAGE_URL = envUrl("GITHUB");

// Every leg here loads that fixture into a BRAND-NEW profile, so each one pays a
// cold HTTP cache and a cold service worker on the heaviest page in the suite -
// measured past 30 s, while the same test retried on a warm machine takes ~10 s.
// The suite already has a knob for exactly this wait (lib/page-settle.ts); use it
// rather than a second, tighter number that only this file believes in.
const SITE_MOUNT_TIMEOUT_MS = Number(process.env.E2E_SITE_TIMEOUT_MS ?? 70_000);

interface OnboardingSession {
  context: BrowserContext;
  generatedUserDataDir: string;
}

async function launchFreshInstall(opts: { keepOnboardingTab: boolean; reuseDir?: string }): Promise<OnboardingSession> {
  const extensionPath = resolveExtensionPath();
  const userDataDir = opts.reuseDir ?? (await makeRunProfileDir("onboarding"));
  const context = await launchRealisticContext(
    userDataDir,
    {
      headless: false,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      args: extensionLaunchArgs({ extensionPaths: [extensionPath], locale: "en-US", windowSize: "1366,900", realisticClient: true }),
    },
    { keepOnboardingTab: opts.keepOnboardingTab },
  );
  return { context, generatedUserDataDir: userDataDir };
}

// The tab is opened by the service worker's install handler, so it can land
// before or after this starts looking - poll the tab set rather than racing a
// single 'page' event.
async function waitForOnboardingPage(context: BrowserContext): Promise<Page> {
  const onboarding = await pollForValue(
    async () => context.pages().find((page) => /\/onboarding\.html/.test(page.url())) ?? null,
    (page) => page !== null,
    20_000,
    250,
  );
  if (!onboarding) throw new Error("The fresh install never opened onboarding.html");
  await onboarding.waitForLoadState("domcontentloaded");
  return onboarding;
}

// The service worker's own view of the global (no-tab) badge text.
function readGlobalBadge(context: BrowserContext): Promise<string> {
  return firstServiceWorker(context).then((worker) => worker.evaluate(() => (globalThis as unknown as { chrome: { action: { getBadgeText: (details: object) => Promise<string> } } }).chrome.action.getBadgeText({})));
}

// One storage.local key, read in the worker - the only context Playwright can
// reach that holds extension storage.
function readLocalKey(context: BrowserContext, key: string): Promise<unknown> {
  return firstServiceWorker(context).then((worker) => worker.evaluate(async (k) => (await (globalThis as unknown as { chrome: { storage: { local: { get: (key: string) => Promise<Record<string, unknown>> } } } }).chrome.storage.local.get(k))[k], key));
}

test("fresh install opens the onboarding page and arms the toolbar dot", async () => {
  test.skip(isFirefoxRun(), FIREFOX_NO_ONBOARDING);
  const session = await launchFreshInstall({ keepOnboardingTab: true });
  try {
    const onboarding = await waitForOnboardingPage(session.context);

    // Four steps on chromium (pin state is readable there), and only the
    // install step starts ticked.
    await expect(onboarding.locator(".step")).toHaveCount(4);
    await expect(onboarding.locator(".step.done")).toHaveCount(1);
    await expect(onboarding.locator(".progress .label")).toHaveText(/1 .* 4/);
    await expect(onboarding.locator("a.primary")).toHaveAttribute("href", TRY_IT_LIVE_URL);

    // The onboarding dot: the GLOBAL default badge plus its storage latch.
    await expect.poll(() => readGlobalBadge(session.context)).toBe("●");
    await expect.poll(() => readLocalKey(session.context, "onboarding_badge_v1")).toBe(true);
  } finally {
    await closeSession(session);
  }
});

// Badge text is session state, not profile state, so the worker re-paints the
// dot on every start while the first reaction is still owed.
//
// NOT tested here: that the onboarding tab does not open a second time. Chromium
// re-fires onInstalled("install") for a `--load-extension` build on EVERY
// launch of the same profile - verified directly: a marker written to
// storage.local in run 1 reads back in run 2 (so the profile did persist) and a
// onboarding tab still opens. The install-only guard is therefore unobservable
// from this harness; what holds it is `details.reason !== "install"` in
// background/install.ts, covered by install.test.ts.
test("the toolbar dot survives a browser restart", async () => {
  test.skip(isFirefoxRun(), FIREFOX_NO_ONBOARDING);
  const first = await launchFreshInstall({ keepOnboardingTab: false });
  await expect.poll(() => readGlobalBadge(first.context), { timeout: 20_000 }).toBe("●");
  await closeSession(first, { keepDir: true });

  const second = await launchFreshInstall({ keepOnboardingTab: false, reuseDir: first.generatedUserDataDir });
  try {
    await expect.poll(() => readGlobalBadge(second.context), { timeout: 20_000 }).toBe("●");
    await expect.poll(() => readLocalKey(second.context, "onboarding_badge_v1")).toBe(true);
  } finally {
    await closeSession(second);
  }
});

test("Try it live opens the live repo in a new tab with the picker up, and the checklist ticks", async () => {
  test.skip(isFirefoxRun(), FIREFOX_NO_ONBOARDING);
  const session = await launchFreshInstall({ keepOnboardingTab: true });
  try {
    const onboarding = await waitForOnboardingPage(session.context);

    // What this leg tests is the DEEP LINK, not which repo the CTA names, so the
    // button is re-pointed at the fixture page while keeping the product's own
    // hash - that hash IS the contract under test. The shipped URL itself is
    // asserted in the first test; here it would only make the run depend on a
    // repository being reachable.
    const cta = onboarding.locator("a.primary");
    const shippedHash = new URL((await cta.getAttribute("href")) ?? "").hash;
    expect(shippedHash, "the CTA must carry the auto-open hint").not.toBe("");
    await cta.evaluate((link, url) => {
      (link as HTMLAnchorElement).href = url;
    }, `${REPO_PAGE_URL}${shippedHash}`);

    // A new tab, so the checklist behind it survives to tick itself.
    const [live] = await Promise.all([session.context.waitForEvent("page"), cta.click()]);
    await live.waitForURL(`${REPO_PAGE_URL}*`, { timeout: 60_000 });

    // The #emojery-react hint auto-opens the picker on the star-row mount; signed
    // out, the palette opens for real. The gate follows the chosen reaction - and
    // only its button opens auth.html.
    await expect(live.locator(SEARCH_INPUT_SELECTOR)).toBeVisible({ timeout: SITE_MOUNT_TIMEOUT_MS });
    await live.locator(GRID_ITEM_SELECTOR).first().click();
    await expect(live.locator(".khasky-emojery-gate-signin")).toBeVisible({ timeout: 15_000 });

    // A deep-linked auto-open teaches the trigger by itself, so it spends the
    // one-shot coach-mark instead of stacking a tooltip under the popover.
    await expect.poll(() => readLocalKey(session.context, "coach_seen_v1")).toBe(true);
    expect(await live.locator(".khasky-emojery-coach-tip").count()).toBe(0);

    // Same latch the onboarding page watches: back on that tab, the button step is
    // ticked without anyone confirming anything.
    await onboarding.bringToFront();
    await expect(onboarding.locator(".step.done")).toHaveCount(2, { timeout: 15_000 });
  } finally {
    await closeSession(session);
  }
});

// The design's whole claim: the page reflects what the extension already knows.
// Visiting a supported site in another tab has to tick the button step here.
test("the checklist ticks itself while the user is on another tab", async () => {
  test.skip(isFirefoxRun(), FIREFOX_NO_ONBOARDING);
  const session = await launchFreshInstall({ keepOnboardingTab: true });
  const page = await session.context.newPage();
  try {
    const onboarding = await waitForOnboardingPage(session.context);
    await expect(onboarding.locator(".step.done")).toHaveCount(1);

    await page.goto(REPO_PAGE_URL);
    await page.locator(HOST_SELECTOR).first().waitFor({ state: "attached", timeout: SITE_MOUNT_TIMEOUT_MS });

    await onboarding.bringToFront();
    await expect(onboarding.locator(".step.done")).toHaveCount(2, { timeout: 15_000 });
    await expect(onboarding.locator(".progress .label")).toHaveText(/2 .* 4/);
  } finally {
    await page.close().catch(() => {});
    await closeSession(session);
  }
});

// The whole first-reaction journey in one session: pick -> gate -> sign-in in the
// auth tab -> the still-open popover casts the held pick by itself -> the vote
// queues -> the toolbar dot retires for good.
test("signing in from the gate casts the held reaction and retires the dot", async () => {
  test.skip(isFirefoxRun(), FIREFOX_NO_ONBOARDING);
  test.skip(!authConfigured(), otpSkipReason("the gate sign-in continuation"));
  const session = await launchFreshInstall({ keepOnboardingTab: false });
  const page = await session.context.newPage();
  let signedIn = false;
  try {
    await page.goto(REPO_PAGE_URL);
    await page.locator(HOST_SELECTOR).first().waitFor({ state: "attached", timeout: SITE_MOUNT_TIMEOUT_MS });
    // A cold page keeps shifting for a moment after the mount, and the popover
    // closes itself when the trigger moves under it (picker-hooks
    // usePopoverPosition onScroll) - so let the layout settle before opening.
    await page.waitForTimeout(2_000);
    // Trusted click on the trigger (fresh install shows the plain trigger; a
    // page with cached counts shows the counter form - accept either).
    await page.locator(TRIGGER_SELECTOR).first().click({ timeout: 30_000 });
    // Signed out still gets the whole palette; the gate follows the pick.
    await expect(page.locator(SEARCH_INPUT_SELECTOR)).toBeVisible({ timeout: 15_000 });
    await page.locator(GRID_ITEM_SELECTOR).first().click();
    await expect(page.locator(".khasky-emojery-gate")).toBeVisible({ timeout: 15_000 });

    // Sign in from a tab of its own (the way the auth page opens for real);
    // the gate popover stays open in the background tab meanwhile.
    await signInTestAccount(session.context);
    signedIn = true;
    await page.bringToFront();
    // No second pick: sign-in casts the reaction the gate was holding and closes.
    await expect(page.locator(".khasky-emojery-gate"), "sign-in must consume the held pick").toHaveCount(0, { timeout: 30_000 });
    await expect.poll(() => readGlobalBadge(session.context), { timeout: 20_000 }).toBe("");
    await expect.poll(() => readLocalKey(session.context, "onboarding_badge_v1")).toBe(false);
  } finally {
    if (signedIn) await ensureSignedOut(session.context).catch(() => {});
    await page.close().catch(() => {});
    await closeSession(session);
  }
});

// Engine-neutral on purpose: the coach-mark is content-script UI, which the
// firefox run drives for real (the onboarding tab plays no part here).
test("the coach-mark shows once on the first live trigger, then never again", async () => {
  const session = await launchFreshInstall({ keepOnboardingTab: false });
  const page = await session.context.newPage();
  try {
    await page.goto(REPO_PAGE_URL);
    const tip = page.locator(".khasky-emojery-coach-tip");
    await expect(tip).toBeVisible({ timeout: 30_000 });

    await page.keyboard.press("Escape");
    await expect(tip).toHaveCount(0);

    // Latched in storage: a reload mounts the trigger again but shows no mark.
    await page.reload();
    await page.locator(HOST_SELECTOR).first().waitFor({ state: "attached", timeout: SITE_MOUNT_TIMEOUT_MS });
    // The mark fires 800ms after a mount; a 3s quiet window proves the latch.
    await page.waitForTimeout(3_000);
    await expect(tip).toHaveCount(0);
  } finally {
    await page.close().catch(() => {});
    await closeSession(session);
  }
});
