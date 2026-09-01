// SPDX-License-Identifier: GPL-3.0-or-later
//
// Accessibility gate for the extension's OWN pages - popup, auth and onboarding. Unlike the
// site suites this never touches a live third-party page, so it is fast and
// deterministic. Four layers:
//   1. axe-core (WCAG A/AA rule tags) across every popup tab and the auth
//      page, in both color schemes;
//   2. aria-snapshot structure asserts - a roles/names/levels regression guard;
//   3. keyboard walk: tab order, roving tablist, visible tabpanel focus ring;
//   4. reflow and text-spacing overflow checks (WCAG 1.4.10 / 1.4.12).
// The in-page picker has real-focus and virtual-screen-reader coverage in
// src/ui/*.browser.test.tsx; site-mounted trigger contrast is covered live by
// theme-contrast.spec.ts.

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { authConfigured, closeSession, extensionPageUrl, FIREFOX_NO_EXTENSION_PAGES, isFirefoxRun, launchSession, openPerSiteList, otpSkipReason, resolveExtensionId, type Session, signIn } from "./lib/extension";

// Whole file drives the extension's own pages (popup/auth), which Playwright Firefox cannot reach.
test.skip(isFirefoxRun(), FIREFOX_NO_EXTENSION_PAGES);

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

const COLOR_SCHEMES = ["light", "dark"] as const;
const POPUP_TABS = ["Settings", "History", "Account", "Report"] as const;

let session: Session;
let context: BrowserContext;
let extensionId: string;

test.beforeAll(async () => {
  // `keepOnboardingTab` is not about the auto-opened tab here - it disables the sweeper
  // that closes ANY page navigating to onboarding.html, which would otherwise close this
  // spec's own onboarding page out from under it a moment after `goto` resolves.
  session = await launchSession({ keepOnboardingTab: true });
  context = session.context;
  const id = await resolveExtensionId(context);
  expect(id, "Emojery must be loaded as an unpacked extension").not.toBeNull();
  extensionId = id as string;
});

test.afterAll(async () => {
  if (session) await closeSession(session);
});

const popupUrl = () => extensionPageUrl(extensionId, "popup.html");
const authUrl = () => extensionPageUrl(extensionId, "auth.html");
// The third extension page, and the only one a user is guaranteed to meet: the browser
// opens it in a tab on every fresh install (background/install.ts openOnboardingPage).
const onboardingUrl = () => extensionPageUrl(extensionId, "onboarding.html");

// New page with axe pre-injected on every navigation. addInitScript goes through
// CDP, so the extension pages' `script-src 'self'` CSP can't block it (a
// <script> tag injection would be).
async function openA11yPage(): Promise<Page> {
  const page = await context.newPage();
  await page.setViewportSize({ width: 380, height: 560 });
  await page.addInitScript({ content: axeSource });
  return page;
}

interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

// One formatted line per violation so a red run names every offender at once.
async function runAxe(page: Page, label: string): Promise<string[]> {
  const violations = (await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (context: Document, options: unknown) => Promise<{ violations: unknown[] }> } }).axe;
    const res = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return res.violations;
  })) as AxeViolation[];
  return violations.map((v) => `${label}: [${v.impact}] ${v.id} (${v.help}) at ${v.nodes.map((n) => n.target.join(" ")).join("; ")}`);
}

test("axe: every popup tab is WCAG A/AA clean in both color schemes", async () => {
  const page = await openA11yPage();
  const violations: string[] = [];
  for (const scheme of COLOR_SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(popupUrl());
    await expect(page.getByRole("tab", { name: "Settings" })).toBeVisible();
    await page.getByRole("tab", { name: "Settings" }).click();
    await openPerSiteList(page);
    for (const tab of POPUP_TABS) {
      await page.getByRole("tab", { name: tab }).click();
      // Anchor on the tab actually being selected and its panel rendered: a fixed beat
      // fails OPEN here - axe over a not-yet-rendered panel finds zero violations and
      // the scan silently checks nothing.
      await expect(page.getByRole("tab", { name: tab })).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tabpanel")).toBeVisible();
      violations.push(...(await runAxe(page, `popup/${tab} (${scheme})`)));
    }
  }
  expect(violations).toEqual([]);
  await page.close();
});

// The fifth panel, reached from the header button rather than the strip: five translated
// labels do not fit the popup's tab strip, so Debug opens from an icon-only toggle and its
// panel is a region, not a tabpanel. Both of those are the parts axe can actually judge.
test("axe: the opt-in Debug panel is WCAG A/AA clean, and costs the tab strip nothing", async () => {
  const page = await openA11yPage();
  const violations: string[] = [];
  for (const scheme of COLOR_SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(popupUrl());
    await page.getByRole("tab", { name: "Settings" }).click();
    const setting = page.getByRole("checkbox", { name: "Debug" });
    // The toggle takes the build stamp's rightmost slice by design, but it is sized to the
    // logo so it must cost no HEIGHT: a 26px button grew the brand row and pushed the strip
    // and the whole panel down 2px every time Debug was switched.
    const verticals = () =>
      page.evaluate(() =>
        [".brand-row", ".tabs", ".tab-panel"].map((sel) => {
          const box = document.querySelector(sel)?.getBoundingClientRect();
          // Rounded on purpose: sub-pixel reflow is not movement, and the regression this
          // guards pushed the strip and the panel down by whole pixels.
          return box ? `${sel} top=${Math.round(box.top)} height=${Math.round(box.height)}` : sel;
        }),
      );
    const before = await verticals();
    await setting.check();

    const openDebug = page.getByRole("button", { name: "Debug" });
    await expect(openDebug).toBeVisible();
    expect(await verticals(), "revealing the Debug toggle must not move anything vertically").toEqual(before);
    // The strip keeps its four tabs - that is the whole reason Debug lives in the header.
    await expect(page.getByRole("tab")).toHaveCount(POPUP_TABS.length);
    await openDebug.click();
    await expect(openDebug).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("region")).toBeVisible();
    // Same rule with no tab selected at all: the active tab's underline is carried by every
    // tab and merely coloured in, so leaving the strip does not shorten it.
    expect(await verticals(), "opening the Debug panel must not move the tab strip").toEqual(before);
    // No tab may claim selection while the panel showing is not a tab's.
    await expect(page.locator('[role="tab"][aria-selected="true"]')).toHaveCount(0);
    violations.push(...(await runAxe(page, `popup/Debug (${scheme})`)));

    // Back to Settings and off again: debugMode is synced storage, so leaving it on would
    // follow this spec's session into every later test.
    await openDebug.click();
    await setting.uncheck();
    await expect(page.getByRole("button", { name: "Debug" })).toHaveCount(0);
  }
  expect(violations).toEqual([]);
  await page.close();
});

test("axe: the auth page is WCAG A/AA clean in both color schemes", async () => {
  const page = await openA11yPage();
  const violations: string[] = [];
  for (const scheme of COLOR_SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(authUrl());
    await expect(page.locator("#email-input")).toBeVisible();
    violations.push(...(await runAxe(page, `auth (${scheme})`)));
  }
  expect(violations).toEqual([]);
  await page.close();
});

test("axe: the onboarding page is WCAG A/AA clean in both color schemes", async () => {
  const page = await openA11yPage();
  const violations: string[] = [];
  for (const scheme of COLOR_SCHEMES) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(onboardingUrl());
    // Anchor on the checklist, not on the heading alone: the confetti and the progress
    // label render after it, and axe over a half-built page finds nothing.
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.getByRole("region").first()).toBeVisible();
    violations.push(...(await runAxe(page, `onboarding (${scheme})`)));
  }
  expect(violations).toEqual([]);
  await page.close();
});

test("aria structure: onboarding is one landmark with a single h1", async () => {
  const page = await openA11yPage();
  await page.goto(onboardingUrl());
  await expect(page.getByRole("main")).toBeVisible();
  // One h1 and no skipped level: the structure a screen-reader user navigates by.
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  await expect(page.getByRole("heading", { level: 3 })).toHaveCount(0);
  await page.close();
});

test("aria structure: popup header, tablist and settings panel", async () => {
  const page = await openA11yPage();
  await page.goto(popupUrl());
  await expect(page.getByRole("heading", { name: "Emojery" })).toBeVisible();
  await page.getByRole("tab", { name: "Settings" }).click();
  await openPerSiteList(page);
  // Subset match: extra rows/toggles may come and go, but the landmark
  // structure, heading levels and the named core controls must hold.
  await expect(page.locator("body")).toMatchAriaSnapshot(`
    - banner:
      - heading "Emojery" [level=1]
      - tablist "Emojery":
        - tab "Settings" [selected]
        - tab "History"
        - tab "Account"
        - tab "Report"
    - tabpanel "Settings":
      - checkbox /Enabled/
      - checkbox /Only selected sites/
      - searchbox "Filter sites"
      - link "Facebook"
      - checkbox "Show the picker on Facebook"
  `);
  await page.close();
});

test("aria structure: auth email step", async () => {
  const page = await openA11yPage();
  await page.goto(authUrl());
  await expect(page.locator("#email-input")).toBeVisible();
  await expect(page.locator("body")).toMatchAriaSnapshot(`
    - main:
      - heading [level=1]
      - textbox "Email"
      - checkbox /I agree to the/
      - link "Terms of Service"
      - link "Privacy Policy"
      - button "Send code" [disabled]
  `);
  await page.close();
});

test("keyboard: popup tab order, roving tablist and a visible panel focus ring", async () => {
  const page = await openA11yPage();
  await page.goto(popupUrl());
  await expect(page.getByRole("tab", { name: "Settings" })).toBeVisible();
  // Selected, not assumed: the popup restores the last tab it was left on, and
  // the roving tabindex follows the SELECTED tab. Reloaded after the click so the
  // keyboard walk below starts from a fresh document rather than from the focus
  // that click left on the tab.
  await page.getByRole("tab", { name: "Settings" }).click();
  await page.reload();
  await expect(page.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "true");

  // The tablist is a single Tab stop (roving tabindex).
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tab", { name: "Settings" })).toBeFocused();

  // The tabpanel is a deliberate second stop per the ARIA tabs pattern; its
  // keyboard focus ring must be visible (WCAG 2.4.7).
  await page.keyboard.press("Tab");
  const panel = page.getByRole("tabpanel");
  await expect(panel).toBeFocused();
  const outline = await panel.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, widthPx: Number.parseFloat(cs.outlineWidth) };
  });
  // WCAG asks for a visible ring, not a specific style: any painted outline
  // with a real width passes, so a ring restyle doesn't fail the walk.
  expect(outline.style, `tabpanel keyboard focus must paint a ring (outline-style: ${outline.style})`).not.toBe("none");
  expect(outline.widthPx, "tabpanel focus ring must have a visible width").toBeGreaterThan(0);

  await page.getByRole("tab", { name: "Settings" }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "History" })).toBeFocused();
  await expect(page.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
  const tabStops = await page.locator('[role="tab"]').evaluateAll((tabs) => tabs.filter((tab) => (tab as HTMLElement).tabIndex === 0).length);
  expect(tabStops).toBe(1);
  await page.close();
});

const hasHorizontalOverflow = (page: Page) => page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth) > 0);

test("reflow: no horizontal scrolling at narrow widths (WCAG 1.4.10)", async () => {
  const page = await openA11yPage();

  // The auth page is a normal tab, so the 320 CSS px reflow breakpoint applies as-is.
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto(authUrl());
  await expect(page.locator("#email-input")).toBeVisible();
  expect(await hasHorizontalOverflow(page), "auth page overflows at 320px").toBe(false);

  // Onboarding is a normal tab too, so it gets the same 320 CSS px breakpoint.
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto(onboardingUrl());
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await hasHorizontalOverflow(page), "onboarding page overflows at 320px").toBe(false);

  // The popup is fixed-size browser chrome with a declared 360px floor
  // (popup.css min-width) - assert no overflow at that floor.
  await page.setViewportSize({ width: 360, height: 480 });
  await page.goto(popupUrl());
  await expect(page.getByRole("tab", { name: "Settings" })).toBeVisible();
  expect(await hasHorizontalOverflow(page), "popup overflows at its 360px floor").toBe(false);
  await page.close();
});

// WCAG 1.4.12 user style overrides. Elements that truncate BY DESIGN (history
// URLs, hints with text-overflow) are exempt; the checked selectors are the
// always-visible reading surfaces that must never clip under these overrides.
const TEXT_SPACING_CSS = `
  * {
    line-height: 1.5 !important;
    letter-spacing: 0.12em !important;
    word-spacing: 0.16em !important;
  }
  p, h1, h2, h3, li { margin-bottom: 2em !important; }
`;

test("text spacing: key text survives WCAG 1.4.12 overrides without clipping", async () => {
  const page = await openA11yPage();
  const clipped: string[] = [];
  const checks: { url: string; selectors: string[] }[] = [
    { url: authUrl(), selectors: [".card h1", ".tagline", "label", ".agree span", "button.primary"] },
    { url: onboardingUrl(), selectors: [".card h1", ".checklist .label"] },
    { url: popupUrl(), selectors: [".tab", ".row-label > span:first-child", ".brand-title span"] },
  ];
  for (const { url, selectors } of checks) {
    await page.goto(url);
    await page.addStyleTag({ content: TEXT_SPACING_CSS });
    // same fail-OPEN hazard as the axe pass above: a pre-layout read finds nothing clipped
    await expect(page.locator(selectors[0] ?? "body").first()).toBeVisible();
    for (const selector of selectors) {
      const overflowing = await page.$$eval(selector, (els) => els.filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1).length);
      if (overflowing > 0) clipped.push(`${url} ${selector}: ${overflowing} clipped element(s)`);
    }
    expect(await hasHorizontalOverflow(page), `page-level overflow after spacing overrides on ${url}`).toBe(false);
  }
  expect(clipped).toEqual([]);
  await page.close();
});

test.describe("authed popup states", () => {
  test.skip(!authConfigured(), otpSkipReason("the authed a11y checks"));

  test("axe: account tab rows and the armed delete flow", async () => {
    await signIn(context);
    const page = await openA11yPage();
    const violations: string[] = [];
    for (const scheme of COLOR_SCHEMES) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(popupUrl());
      await page.getByRole("tab", { name: "Account" }).click();
      await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
      violations.push(...(await runAxe(page, `popup/Account signed-in (${scheme})`)));

      // Arm the delete flow (slider + warning visible), scan, then back out -
      // never confirm: this is the primary test account.
      await page.getByRole("button", { name: "Delete" }).click();
      await expect(page.getByRole("slider")).toBeVisible();
      violations.push(...(await runAxe(page, `popup/Account delete-armed (${scheme})`)));
      await page.getByRole("button", { name: "Cancel" }).click();
    }
    expect(violations).toEqual([]);
    await page.close();
  });
});
