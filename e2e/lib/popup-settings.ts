// SPDX-License-Identifier: GPL-3.0-or-later
//
// Driving the popup's Settings/Account toggles to a target state. Every helper
// here works around the same thing: the popup paints its defaults before the
// persisted settings merge in, and the per-site section collapses the moment no
// site is excluded - so a plain `setChecked` waits on a node that may be gone.
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { enMessage } from "./auth-signin";
import { isFirefoxRun } from "./browser-session";
import { openPopup } from "./extension-pages";
import { firefoxBridge } from "./firefox-bridge";
import { ROW_SELECT_SELECTOR } from "./selectors";

// Prefix of a per-site row's accessible name ("Show the picker on Facebook"),
// derived from the shipped template by splitting on a NUL stand-in for the site
// name, so a copy rename fails loudly here. Those rows live inside the
// collapsed section, so reaching one means opening it first.
const PER_SITE_ROW_PREFIX = enMessage("perSiteToggleAria", "\u0000").split("\u0000")[0]!;

// The per-site rows ship collapsed behind the "Only selected sites" toggle. That toggle
// only persists in the ON direction - turning it OFF clears every exclusion - so a freshly
// opened popup starts collapsed again unless some site is already off. Idempotent.
export async function openPerSiteList(popup: Page): Promise<void> {
  const toggle = popup.getByRole("checkbox", { name: enMessage("sectionPerSite") });
  if (!(await toggle.isChecked())) await toggle.check();
  await expect(popup.getByRole("searchbox", { name: enMessage("filterSitesPlaceholder") })).toBeVisible();
}

// Flip one per-site row (by its full accessible name) in an already-open popup.
//
// Not locator.setChecked(): re-enabling the LAST excluded site empties the exclusion set,
// which makes the section's derived state false, so it collapses and takes the row with it.
// setChecked then waits for a checked state on a node that no longer exists and times out
// on a click that in fact succeeded. A vanished row can only mean "no site is excluded",
// which is exactly the enabled=true outcome, so accept it as one.
async function setPerSiteEnabled(popup: Page, rowName: string, enabled: boolean): Promise<void> {
  await openPerSiteList(popup);
  const row = popup.getByRole("checkbox", { name: rowName });
  await expect(row).toBeVisible();
  if ((await row.isChecked()) !== enabled) await row.click();
  await expect
    .poll(
      async () => {
        // A vanished row means the section collapsed, which happens only when NO site is
        // excluded - so it reads as "on", and never satisfies a disable.
        if ((await row.count()) === 0) return true;
        return row.isChecked();
      },
      { message: `"${rowName}" should end up ${enabled ? "on" : "off"}` },
    )
    .toBe(enabled);
}

/** The Theme row's stored values, which are also its `<option>` values. */
export type PopupThemeChoice = "light" | "dark" | "system";

// The Theme row is the popup's only <select>, and its option values ARE the stored
// preference - so this drives it by value and needs no localized option label.
export async function setPopupTheme(context: BrowserContext, choice: PopupThemeChoice): Promise<void> {
  if (isFirefoxRun()) return setPopupThemeOverBridge(context, choice);
  const popup = await openPopup(context);
  try {
    await popup.getByRole("tab", { name: "Settings" }).click();
    const select = popup.locator(ROW_SELECT_SELECTOR);
    await expect(select).toBeVisible();
    // The same hydration race setPopupCheckbox works around: the popup paints
    // DEFAULT_SETTINGS first and the stored merge lands one storage read later,
    // reverting a selection made inside that window.
    await popup.waitForTimeout(300);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await select.selectOption(choice);
      await popup.waitForTimeout(250);
      if ((await select.inputValue()) === choice) break;
    }
    await expect(select).toHaveValue(choice);
  } finally {
    await popup.close().catch(() => {});
  }
}

// Set a settings checkbox (by accessible name) in the popup to a target state,
// retrying since the popup paints defaults before merging persisted settings.
export async function setPopupCheckbox(context: BrowserContext, opts: { tab: "Settings" | "Account"; name: string; checked: boolean }): Promise<void> {
  if (isFirefoxRun()) return setPopupCheckboxOverBridge(context, opts);
  const popup = await openPopup(context);
  try {
    await popup.getByRole("tab", { name: opts.tab }).click();
    if (opts.name.startsWith(PER_SITE_ROW_PREFIX)) {
      await setPerSiteEnabled(popup, opts.name, opts.checked);
      return;
    }
    const toggle = popup.getByRole("checkbox", { name: opts.name });
    await expect(toggle).toBeVisible();
    // Visible is not yet interactive here: the popup hydrates its settings asynchronously,
    // and a setChecked landing before that read is silently reverted by the first render.
    await popup.waitForTimeout(300);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if ((await toggle.isChecked()) !== opts.checked) {
        await toggle.setChecked(opts.checked);
      }
      // The write goes to storage and comes back as a re-render; nothing resolves when it
      // lands, so settle before re-reading and let the attempt loop cover a slow one.
      await popup.waitForTimeout(250);
      if ((await toggle.isChecked()) === opts.checked) break;
    }
    if (opts.checked) await expect(toggle).toBeChecked();
    else await expect(toggle).not.toBeChecked();
  } finally {
    await popup.close().catch(() => {});
  }
}

// The firefox run's twins of the two drivers above: the popup opened as a tab by
// firefox-bridge.ts and driven by ONE evaluated function that does what the
// locator sequence does - select the tab, resolve the control by its accessible
// name (aria-label, else the wrapping label's text, as getByRole reads it), click
// it, and re-read through the same hydration retries. A synthetic click on a
// checkbox toggles it and fires change, which is the event the popup persists on.
async function setPopupCheckboxOverBridge(context: BrowserContext, opts: { tab: "Settings" | "Account"; name: string; checked: boolean }): Promise<void> {
  const tab = await (await firefoxBridge(context)).openExtensionTab("popup.html");
  try {
    const outcome = await tab.evaluate(
      async ({ tab, name, checked, perSiteSection, perSiteRow }) => {
        const sleep = (ms: number) => new Promise<void>((settle) => setTimeout(settle, ms));
        const nameOf = (input: HTMLInputElement): string => {
          const own = input.getAttribute("aria-label");
          if (own) return own;
          const label = input.closest("label") ?? (input.id ? document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(input.id)}"]`) : null);
          return (label?.textContent ?? "").replace(/\s+/g, " ").trim();
        };
        const checkbox = (needle: string): HTMLInputElement | null => Array.from(document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')).find((input) => nameOf(input).includes(needle)) ?? null;
        // The popup renders its tab strip and, one storage read later, the panel
        // rows - the same wait a locator's auto-retry gives the Chromium driver.
        const appear = async <T>(find: () => T | null): Promise<T | null> => {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const found = find();
            if (found || Date.now() > deadline) return found;
            await sleep(100);
          }
        };
        const tabButton = await appear(() => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((el) => (el.textContent ?? "").includes(tab)) ?? null);
        if (!tabButton) return { error: `no "${tab}" tab in the popup` };
        tabButton.click();
        await sleep(300);
        if (perSiteRow) {
          const section = await appear(() => checkbox(perSiteSection));
          if (!section) return { error: `no "${perSiteSection}" toggle in the Settings panel` };
          if (!section.checked) {
            section.click();
            await sleep(250);
          }
        }
        if (!(await appear(() => checkbox(name)))) return perSiteRow && checked ? { ok: true } : { error: `no checkbox named "${name}" in the ${tab} panel` };
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const target = checkbox(name);
          // A vanished per-site row means the section collapsed because no site is
          // excluded any more - which is the enabled=true outcome (see setPerSiteEnabled).
          if (!target) return perSiteRow && checked ? { ok: true } : { error: `no checkbox named "${name}" in the ${tab} panel` };
          if (target.checked !== checked) target.click();
          await sleep(250);
          const after = checkbox(name);
          if (!after) return perSiteRow && checked ? { ok: true } : { error: `the "${name}" checkbox disappeared after the click` };
          if (after.checked === checked) return { ok: true };
        }
        return { error: `"${name}" never settled at ${checked ? "on" : "off"}` };
      },
      { tab: opts.tab, name: opts.name, checked: opts.checked, perSiteSection: enMessage("sectionPerSite"), perSiteRow: opts.name.startsWith(PER_SITE_ROW_PREFIX) },
    );
    if ("error" in outcome) throw new Error(`popup over the Firefox bridge: ${outcome.error}`);
  } finally {
    await tab.close();
  }
}

async function setPopupThemeOverBridge(context: BrowserContext, choice: PopupThemeChoice): Promise<void> {
  const tab = await (await firefoxBridge(context)).openExtensionTab("popup.html");
  try {
    const outcome = await tab.evaluate(
      async ({ choice, selector }) => {
        const sleep = (ms: number) => new Promise<void>((settle) => setTimeout(settle, ms));
        const appear = async <T>(find: () => T | null): Promise<T | null> => {
          const deadline = Date.now() + 10_000;
          for (;;) {
            const found = find();
            if (found || Date.now() > deadline) return found;
            await sleep(100);
          }
        };
        const tabButton = await appear(() => Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]')).find((el) => (el.textContent ?? "").includes("Settings")) ?? null);
        if (!tabButton) return { error: "no Settings tab in the popup" };
        tabButton.click();
        await sleep(300);
        if (!(await appear(() => document.querySelector<HTMLSelectElement>(selector)))) return { error: "no Theme select in the Settings panel" };
        for (let attempt = 0; attempt < 5; attempt += 1) {
          const select = document.querySelector<HTMLSelectElement>(selector);
          if (!select) return { error: "no Theme select in the Settings panel" };
          select.value = choice;
          select.dispatchEvent(new Event("change", { bubbles: true }));
          await sleep(250);
          if (document.querySelector<HTMLSelectElement>(selector)?.value === choice) return { ok: true };
        }
        return { error: `the Theme select never settled at "${choice}"` };
      },
      { choice, selector: ROW_SELECT_SELECTOR },
    );
    if ("error" in outcome) throw new Error(`popup over the Firefox bridge: ${outcome.error}`);
  } finally {
    await tab.close();
  }
}
