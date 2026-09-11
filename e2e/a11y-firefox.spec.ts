// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Gecko half of the accessibility gate: the axe, reflow and text-spacing
// layers of a11y.spec.ts, run against the extension's own pages in Playwright's
// Firefox. Those pages are unreachable for Playwright there, so each one is
// opened as its own sized window through firefox-bridge.ts and judged by
// functions evaluated in it - which is all the three layers ever needed.
// The other two layers (aria snapshots, the keyboard walk) need Playwright's
// own page machinery and stay Chromium-only in a11y.spec.ts.
//
// Colour scheme is a launch pref on Firefox (the pages the bridge opens follow
// the OS setting, not Playwright's emulation), so the schemes are two sessions
// rather than two emulateMedia calls.
import { expect, test } from "@playwright/test";
import { type AxeViolation, axeSource, COLOR_SCHEMES, formatViolations, POPUP_TABS, TEXT_SPACING_CSS, WCAG_TAGS } from "./lib/axe";
import { closeSession, enMessage, type FirefoxExtensionTab, firefoxBridge, isFirefoxRun, launchSession } from "./lib/extension";
import { AGREE_SELECTOR, CARD_SELECTOR, EMAIL_INPUT_SELECTOR, TAGLINE_SELECTOR } from "./lib/selectors";

test.skip(!isFirefoxRun(), "the Chromium run scans these pages through Playwright pages in a11y.spec.ts");
// Browser-local: no network, no account - a red run here is a product bug.
test.describe.configure({ retries: 0 });

type Scheme = (typeof COLOR_SCHEMES)[number];

async function launch(scheme: Scheme) {
  // viewport: null so the popup windows opened below can be sized (see
  // FirefoxExtensionTab.setContentSize); keepOnboardingTab as in a11y.spec.ts.
  return launchSession({ keepOnboardingTab: true, viewport: null, colorScheme: scheme });
}

// An extension page in its own window at the size the Chromium spec gives its
// Playwright page, with axe injected and the colour scheme confirmed - a page
// rendered under the wrong scheme would scan the wrong palette and pass.
async function openSizedPage(context: Parameters<typeof firefoxBridge>[0], path: string, size: { width: number; height: number }, scheme: Scheme): Promise<FirefoxExtensionTab> {
  const page = await (await firefoxBridge(context)).openExtensionWindow(path, size);
  await page.setContentSize(size);
  expect(await page.evaluate(() => matchMedia("(prefers-color-scheme: dark)").matches), `${path} should render in the ${scheme} scheme`).toBe(scheme === "dark");
  await page.injectScript(axeSource);
  return page;
}

async function runAxe(page: FirefoxExtensionTab, label: string): Promise<string[]> {
  const violations = await page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: { run: (context: Document, options: unknown) => Promise<{ violations: AxeViolation[] }> } }).axe;
    const res = await axe.run(document, { runOnly: { type: "tag", values: tags } });
    return res.violations;
  }, WCAG_TAGS);
  return formatViolations(label, violations);
}

// Poll until `probe` returns true in the page - the evaluate-only twin of an
// `expect(locator).toBeVisible()` anchor, so no scan runs over a half-built page.
async function waitInPage<A>(page: FirefoxExtensionTab, probe: (arg: A) => boolean, arg: A, what: string): Promise<void> {
  await expect.poll(() => page.evaluate(probe, arg), { message: what }).toBe(true);
}

const hasHorizontalOverflow = (page: FirefoxExtensionTab) => page.evaluate(() => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth) > 0);

for (const scheme of COLOR_SCHEMES) {
  test(`axe: every popup tab, the auth page and onboarding are WCAG A/AA clean (${scheme})`, async () => {
    const session = await launch(scheme);
    const violations: string[] = [];
    try {
      const popup = await openSizedPage(session.context, "popup.html", { width: 380, height: 560 }, scheme);
      try {
        // Settings first, with the per-site list opened, as a11y.spec.ts does; then
        // every tab, each anchored on its panel having rendered.
        const settings = { tab: "Settings", perSite: enMessage("sectionPerSite"), filter: enMessage("filterSitesPlaceholder") };
        await waitInPage(popup, (tab) => Array.from(document.querySelectorAll('[role="tab"]')).some((el) => (el.textContent ?? "").includes(tab)), settings.tab, "the popup tab strip should render");
        await popup.evaluate(({ tab, perSite }) => {
          Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
            .find((el) => (el.textContent ?? "").includes(tab))
            ?.click();
          const section = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((input) => (input.closest("label")?.textContent ?? "").includes(perSite));
          if (section && !section.checked) section.click();
        }, settings);
        await waitInPage(popup, (filter) => document.querySelector(`input[type="search"][aria-label="${filter}"]`) !== null, settings.filter, "the per-site list should open");
        for (const tab of POPUP_TABS) {
          await popup.evaluate((tab) => {
            Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'))
              .find((el) => (el.textContent ?? "").includes(tab))
              ?.click();
          }, tab);
          await waitInPage(popup, (tab) => Array.from(document.querySelectorAll('[role="tab"]')).some((el) => (el.textContent ?? "").includes(tab) && el.getAttribute("aria-selected") === "true") && document.querySelector('[role="tabpanel"]') !== null, tab, `the ${tab} tab should be selected with its panel rendered`);
          violations.push(...(await runAxe(popup, `popup/${tab} (${scheme})`)));
        }
      } finally {
        await popup.close();
      }

      const auth = await openSizedPage(session.context, "auth.html", { width: 380, height: 560 }, scheme);
      try {
        await waitInPage(auth, (selector) => document.querySelector(selector) !== null, EMAIL_INPUT_SELECTOR, "the auth email step should render");
        violations.push(...(await runAxe(auth, `auth (${scheme})`)));
      } finally {
        await auth.close();
      }

      const onboarding = await openSizedPage(session.context, "onboarding.html", { width: 380, height: 560 }, scheme);
      try {
        // Anchor on the checklist, not on the heading alone (see a11y.spec.ts).
        await waitInPage(onboarding, () => document.querySelector("h1") !== null && document.querySelector('[role="region"], section[aria-label], section[aria-labelledby]') !== null, undefined, "the onboarding checklist should render");
        violations.push(...(await runAxe(onboarding, `onboarding (${scheme})`)));
      } finally {
        await onboarding.close();
      }
    } finally {
      await closeSession(session);
    }
    expect(violations).toEqual([]);
  });
}

test("reflow: no horizontal scrolling at narrow widths (WCAG 1.4.10)", async () => {
  const session = await launch("light");
  try {
    // The auth and onboarding pages are normal tabs, so the 320 CSS px reflow
    // breakpoint applies as-is; the popup is fixed-size browser chrome with a
    // declared 360px floor (popup.css min-width).
    const checks: Array<{ path: string; width: number; ready: (arg: string) => boolean; arg: string }> = [
      { path: "auth.html", width: 320, ready: (selector) => document.querySelector(selector) !== null, arg: EMAIL_INPUT_SELECTOR },
      { path: "onboarding.html", width: 320, ready: () => document.querySelector("h1") !== null, arg: "" },
      { path: "popup.html", width: 360, ready: (tab) => Array.from(document.querySelectorAll('[role="tab"]')).some((el) => (el.textContent ?? "").includes(tab)), arg: "Settings" },
    ];
    for (const check of checks) {
      const page = await openSizedPage(session.context, check.path, { width: check.width, height: 480 }, "light");
      try {
        await waitInPage(page, check.ready, check.arg, `${check.path} should render`);
        expect(await hasHorizontalOverflow(page), `${check.path} overflows at ${check.width}px`).toBe(false);
      } finally {
        await page.close();
      }
    }
  } finally {
    await closeSession(session);
  }
});

test("text spacing: key text survives WCAG 1.4.12 overrides without clipping", async () => {
  const session = await launch("light");
  const clipped: string[] = [];
  try {
    const checks: { path: string; selectors: string[] }[] = [
      { path: "auth.html", selectors: [`${CARD_SELECTOR} h1`, TAGLINE_SELECTOR, "label", `${AGREE_SELECTOR} span`, "button.primary"] },
      { path: "onboarding.html", selectors: [".card h1", ".checklist .label"] },
      { path: "popup.html", selectors: [".tab", ".row-label > span:first-child", ".brand-title span"] },
    ];
    for (const { path, selectors } of checks) {
      const page = await openSizedPage(session.context, path, { width: 380, height: 560 }, "light");
      try {
        // same fail-OPEN hazard as the axe pass: a pre-layout read finds nothing clipped
        await waitInPage(page, (selector) => document.querySelector(selector) !== null, selectors[0] ?? "body", `${path} should render its first checked surface`);
        const overflowing = await page.evaluate(
          ({ css, selectors }) => {
            const style = document.createElement("style");
            style.textContent = css;
            document.head.append(style);
            // Force the restyle before measuring.
            void document.body.offsetWidth;
            return selectors.map((selector) => ({ selector, count: Array.from(document.querySelectorAll<HTMLElement>(selector)).filter((el) => el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1).length }));
          },
          { css: TEXT_SPACING_CSS, selectors },
        );
        for (const { selector, count } of overflowing) {
          if (count > 0) clipped.push(`${path} ${selector}: ${count} clipped element(s)`);
        }
        expect(await hasHorizontalOverflow(page), `page-level overflow after spacing overrides on ${path}`).toBe(false);
      } finally {
        await page.close();
      }
    }
  } finally {
    await closeSession(session);
  }
  expect(clipped).toEqual([]);
});
