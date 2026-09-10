// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings-behavior gaps: the "Reaction animations" toggle gates the
// emoji click burst (applies to the NEXT click, no reload) and the page-load
// intro burst (decided at mount, so a reload); a second, already-open popup does
// not live-sync a settings change until reopened (characterized, so a future
// live-sync change is a conscious one); the popup reopens on the tab it was last
// left on; turning a site off per-site restores the native control replace-native hid;
// the Theme setting repaints a live trigger and the extension's own pages; and the
// Debug setting is what reveals the queue panel.
//
// OS reduced-motion suppresses the bursts on top of the toggle (src/ui/animations.ts),
// so these cases must never emulate reduce-motion.
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import * as ext from "./lib/extension";
import { reloadAndSettle } from "./lib/reload-settle";
import { CLICK_FLOAT_CLASS, DEBUG_TAB_SELECTOR, HISTORY_DAY_SELECTOR, HOST_SELECTOR, INTRO_PARTICLE_CLASS, TAB_PANEL_SELECTOR } from "./lib/selectors";

const REQUIRES_OTP = ext.otpSkipReason("the animations-toggle e2e check");

// Whole file toggles settings through the popup, which Playwright Firefox cannot reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);

// Arm a page-wide watcher for the click-burst element BEFORE reacting; the burst
// lives only ~600ms, so a post-hoc query would race its removal.
async function armClickBurstWatcher(page: Page): Promise<void> {
  await page.evaluate((clickFloatClass) => {
    const w = window as unknown as { __emSawClickBurst?: boolean; __emBurstObserver?: MutationObserver };
    w.__emSawClickBurst = false;
    w.__emBurstObserver?.disconnect();
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLElement && node.classList.contains(clickFloatClass)) {
            w.__emSawClickBurst = true;
          }
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true });
    w.__emBurstObserver = observer;
  }, CLICK_FLOAT_CLASS);
}

async function sawClickBurst(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __emSawClickBurst?: boolean }).__emSawClickBurst === true);
}

test("reaction animations toggle gates the click burst without a reload", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    const page = await ext.signedInGithubPage(session.context);
    // The burst only spawns on an actual pick, and reactWith SKIPS the click on
    // an option that still reads as selected - so an un-react the trigger hasn't
    // caught up with yet turns this into "no click, no burst" and fails the ON
    // phase. Wait the clear out before arming the watcher.
    await ext.ensureNoOwnReaction(session.context, page);

    await armClickBurstWatcher(page);
    await ext.reactWith(page, ext.REACTIONS.heart);
    await expect.poll(() => sawClickBurst(page), { message: "a reaction click should spawn the emoji burst while animations are ON" }).toBe(true);

    // Toggle OFF applies to the very next click - NO page reload in between.
    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Reaction animations", checked: false });
    await armClickBurstWatcher(page);
    await ext.reactWith(page, ext.REACTIONS.fire);
    await page.waitForTimeout(1_200); // give a burst (if wrongly spawned) time to appear
    expect(await sawClickBurst(page), "no emoji burst may spawn while animations are OFF").toBe(false);

    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Reaction animations", checked: true });
    await ext.clearReaction(page);
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// Two popups at once: the popup reads settings when it opens and does not
// subscribe to later changes, so an already-open second popup keeps showing the
// old value; reopening it shows the new one. This pins the CURRENT contract -
// if live sync is ever added, this test should be updated deliberately.
test("an already-open second popup shows stale settings until reopened", async () => {
  const session = await ext.launchSession();
  try {
    const first = await ext.openPopup(session.context);
    const second = await ext.openPopup(session.context);
    try {
      await second.getByRole("tab", { name: "Settings" }).click();
      const secondEnabled = second.getByRole("checkbox", { name: "Enabled" });
      await expect(secondEnabled).toBeChecked();

      await first.getByRole("tab", { name: "Settings" }).click();
      const firstEnabled = first.getByRole("checkbox", { name: "Enabled" });
      await firstEnabled.setChecked(false);
      await expect(firstEnabled).not.toBeChecked();

      // The whole point of the case is that nothing arrives. Generous on purpose:
      // this is the window a live-sync would have propagated in, so a shorter wait
      // would make the assertion pass for the wrong reason.
      await second.waitForTimeout(2_000);
      await expect(secondEnabled, "an already-open popup keeps the value it loaded with").toBeChecked();
    } finally {
      await second.close().catch(() => {});
      await first.close().catch(() => {});
    }

    const reopened = await ext.openPopup(session.context);
    try {
      await reopened.getByRole("tab", { name: "Settings" }).click();
      const reopenedEnabled = reopened.getByRole("checkbox", { name: "Enabled" });
      await expect(reopenedEnabled, "a reopened popup loads the changed value").not.toBeChecked();
      await reopenedEnabled.setChecked(true);
      await expect(reopenedEnabled).toBeChecked();
    } finally {
      await reopened.close().catch(() => {});
    }
  } finally {
    await ext.closeSession(session);
  }
});

// The popup is destroyed on close, so the tab it reopens on is state it has to
// persist itself. Needs no sign-in: every tab renders signed-out (History and
// Account as their sign-in prompt), which is exactly the state to restore into.
test("the popup reopens on the tab it was last left on", async () => {
  const session = await ext.launchSession();
  try {
    const first = await ext.openPopup(session.context);
    try {
      await expect(first.getByRole("tab", { name: "Settings" }), "a first-run popup starts on Settings").toHaveAttribute("aria-selected", "true");
      await first.getByRole("tab", { name: "History" }).click();
      await expect(first.getByRole("tab", { name: "History" })).toHaveAttribute("aria-selected", "true");
    } finally {
      await first.close().catch(() => {});
    }

    const reopened = await ext.openPopup(session.context);
    try {
      await expect(reopened.getByRole("tab", { name: "History" }), "a reopened popup lands on the tab it was left on").toHaveAttribute("aria-selected", "true");
      await expect(reopened.getByRole("tab", { name: "Settings" })).toHaveAttribute("aria-selected", "false");
      // And the memory follows the newest choice, not the first one.
      await reopened.getByRole("tab", { name: "Report" }).click();
    } finally {
      await reopened.close().catch(() => {});
    }

    const third = await ext.openPopup(session.context);
    try {
      await expect(third.getByRole("tab", { name: "Report" })).toHaveAttribute("aria-selected", "true");
    } finally {
      await third.close().catch(() => {});
    }
  } finally {
    await ext.closeSession(session);
  }
});

// With Hide original buttons ON the native control is hidden; turning the
// SITE off (per-site toggle) must bring the native control back. Asserted via
// the extension-owned `data-khasky-emojery-hidden` marker (light DOM), not
// any site-specific selector. Needs no sign-in (hosts + replacement work logged-out).
test("replace-native + per-site off restores the native control", async () => {
  const session = await ext.launchSession();
  try {
    const page = await ext.openGithub(session.context);
    await expect.poll(() => ext.visibleHostCount(page), { message: "picker should mount on GitHub by default" }).toBeGreaterThan(0);
    expect(await ext.hiddenNativeCount(page), "nothing is hidden while Replace is off (the default)").toBe(0);

    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Hide original buttons", checked: true });
    // The hide can land a beat after the mount, so the settle covers Replace too.
    await reloadAndSettle(page, 1_500);
    await expect.poll(() => ext.visibleHostCount(page), { message: "picker should still mount with Replace on" }).toBeGreaterThan(0);
    await expect.poll(() => ext.hiddenNativeCount(page), { message: "Replace on should hide the native control" }).toBeGreaterThan(0);

    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Show the picker on GitHub", checked: false });
    // Give a would-be mount time to happen, so the zero-reads below mean removed, not not-yet-scanned.
    await reloadAndSettle(page, 1_500);
    await expect.poll(() => ext.visibleHostCount(page), { message: "disabling GitHub per-site should remove the picker" }).toBe(0);
    await expect.poll(() => ext.hiddenNativeCount(page), { message: "a disabled site must not keep the native control hidden - Replace must not win over per-site off" }).toBe(0);
  } finally {
    // Restore defaults so a shared/kept profile isn't left with GitHub disabled.
    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Show the picker on GitHub", checked: true }).catch(() => {});
    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Hide original buttons", checked: false }).catch(() => {});
    await ext.closeSession(session);
  }
});

// Install a page-init watcher (BEFORE the site's scripts run, re-armed on every
// navigation) that flags when the page-load intro burst spawns a particle.
async function armIntroWatcher(page: Page): Promise<void> {
  await page.addInitScript((introParticleClass: string) => {
    const flagHolder = window as unknown as { __emSawIntro?: boolean };
    flagHolder.__emSawIntro = false;
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLElement && (node.classList.contains(introParticleClass) || node.querySelector?.(`.${introParticleClass}`))) {
            flagHolder.__emSawIntro = true;
          }
        }
      }
    });
    const start = () => observer.observe(document.documentElement, { subtree: true, childList: true });
    if (document.documentElement) start();
    else addEventListener("DOMContentLoaded", start);
  }, INTRO_PARTICLE_CLASS);
}

async function sawIntro(page: Page): Promise<boolean> {
  return page.evaluate(() => (window as unknown as { __emSawIntro?: boolean }).__emSawIntro === true);
}

// The page-load intro animation is decided at mount, so - unlike the click
// burst above - a toggle change only takes effect after a reload, and it honors
// the Reaction animations switch. Runs authed so the target reliably has a
// public reaction (this account's own) for the intro to play.
test("intro animation replays on reload and honors the animations toggle", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  test.setTimeout(Number(process.env.E2E_INTRO_TEST_TIMEOUT_MS ?? 180_000));
  const session = await ext.launchSession();
  try {
    const page = await ext.signedInGithubPage(session.context);
    // Guarantee a public reaction so the intro has a non-zero count to animate. The vote
    // has to be through the server AND into the counts a reload reads before the watcher
    // is armed, so wait for the RENDERED total to settle rather than budgeting a fixed
    // sleep for the round-trip.
    await ext.ensureNoOwnReaction(session.context, page);
    await ext.reactWith(page, ext.REACTIONS.heart);
    await expect.poll(() => ext.hasOwnReaction(page)).toBe(true);
    // Tighter than the helper's own 90s default: this only needs the count to be readable,
    // not an exact aggregate, and the case still has two reloads and an intro wait to pay for.
    await ext.waitForSettledTotal(page, { timeout: 40_000, interval: 5_000 });

    await armIntroWatcher(page);

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
    await expect.poll(() => sawIntro(page), { message: "the intro burst should replay on reload while animations are ON", timeout: 25_000 }).toBe(true);

    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Reaction animations", checked: false });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(6_000); // give a wrongly-spawned intro time to appear
    expect(await sawIntro(page), "no intro burst may play while animations are OFF").toBe(false);

    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Reaction animations", checked: true });
    await ext.clearReaction(page);
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// The trigger host carries the resolved palette as `data-theme` (ui/themed-hosts.ts),
// so the Theme setting is observable on a live page without sampling any color.
async function mountedHostTheme(page: Page): Promise<string | null> {
  return page.locator(`${HOST_SELECTOR}[data-theme]`).first().getAttribute("data-theme");
}

// Forcing a palette must reach the mounted trigger through the settings watcher,
// with no reload - and handing it back to "System" must return the page's own
// answer. The baseline is READ rather than asserted: which palette GitHub serves
// logged-out is the site's business, and the case is about the delta.
test("the Theme setting repaints a mounted trigger with no reload", async () => {
  const session = await ext.launchSession();
  try {
    const page = await ext.openGithub(session.context);
    await expect.poll(() => ext.visibleHostCount(page), { message: "picker should mount on GitHub by default" }).toBeGreaterThan(0);
    const systemBaseline = await mountedHostTheme(page);
    expect(systemBaseline, "a mounted host should carry a resolved palette").not.toBeNull();

    await ext.setPopupTheme(session.context, "dark");
    await expect.poll(() => mountedHostTheme(page), { message: "forcing Dark should repaint the mounted trigger in place" }).toBe("dark");

    await ext.setPopupTheme(session.context, "light");
    await expect.poll(() => mountedHostTheme(page), { message: "forcing Light should repaint the mounted trigger in place" }).toBe("light");

    await ext.setPopupTheme(session.context, "system");
    await expect.poll(() => mountedHostTheme(page), { message: "System should hand the palette back to the page" }).toBe(systemBaseline);
  } finally {
    await ext.closeSession(session);
  }
});

// An extension page has no host site to blend with, so its palette is the setting
// itself - resolved against the BROWSER only while it says System. Emulating the
// browser preference needs a reload: the page reads it once, at bootstrap.
async function expectPopupTheme(context: BrowserContext, expected: string, colorScheme?: "light" | "dark"): Promise<void> {
  const popup = await ext.openPopup(context);
  try {
    if (colorScheme) {
      await popup.emulateMedia({ colorScheme });
      await popup.reload();
      await expect(popup.getByRole("heading", { name: "Emojery" })).toBeVisible();
    }
    await expect(popup.locator("html")).toHaveAttribute("data-theme", expected);
  } finally {
    await popup.close().catch(() => {});
  }
}

test("the Theme setting drives the extension pages, and System follows the browser", async () => {
  const session = await ext.launchSession();
  try {
    await ext.setPopupTheme(session.context, "dark");
    await expectPopupTheme(session.context, "dark");

    await ext.setPopupTheme(session.context, "light");
    await expectPopupTheme(session.context, "light");

    await ext.setPopupTheme(session.context, "system");
    await expectPopupTheme(session.context, "dark", "dark");
    await expectPopupTheme(session.context, "light", "light");
  } finally {
    await ext.closeSession(session);
  }
});

// The Debug panel ships in every build behind the setting (docs/development.md).
// The header's bug button is in the DOM either way and `display: none` until the
// setting is on (.debug-toggle-off), so "revealed" is a visibility assertion. The
// panel's summary is deliberately un-i18n'd (popup-queue.tsx): the text below is
// the queue's own state, not a translation.
test("Debug mode reveals the queue panel and hides it again", async () => {
  const session = await ext.launchSession();
  try {
    const beforeToggle = await ext.openPopup(session.context);
    try {
      await expect(beforeToggle.locator(DEBUG_TAB_SELECTOR), "the bug button stays hidden while Debug is off").toBeHidden();
    } finally {
      await beforeToggle.close().catch(() => {});
    }

    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Debug", checked: true });

    const withDebug = await ext.openPopup(session.context);
    try {
      const bugButton = withDebug.locator(DEBUG_TAB_SELECTOR);
      await expect(bugButton).toBeVisible();
      await bugButton.click();
      const summary = withDebug.locator(HISTORY_DAY_SELECTOR);
      await expect(summary, "an idle queue reads as empty, not as an error").toContainText("0 queued");
      await expect(summary).toContainText("no hold");
      await expect(summary).toContainText("0 consecutive failures");
      await expect(withDebug.getByRole("alert"), "reading the queue must not fail").toHaveCount(0);
    } finally {
      await withDebug.close().catch(() => {});
    }

    await ext.setPopupCheckbox(session.context, { tab: "Settings", name: "Debug", checked: false });

    // The popup reopens on the view it was left on, and that view was Debug - with
    // the setting off it has to fall back to Settings rather than render nothing.
    const afterToggle = await ext.openPopup(session.context);
    try {
      await expect(afterToggle.locator(DEBUG_TAB_SELECTOR), "switching Debug off takes the bug button away again").toBeHidden();
      await expect(afterToggle.locator(TAB_PANEL_SELECTOR)).not.toContainText("queued");
      await expect(afterToggle.getByRole("tab", { name: "Settings" }), "a remembered Debug view falls back to Settings").toHaveAttribute("aria-selected", "true");
    } finally {
      await afterToggle.close().catch(() => {});
    }
  } finally {
    await ext.closeSession(session);
  }
});
