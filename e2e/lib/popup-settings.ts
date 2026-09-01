// SPDX-License-Identifier: GPL-3.0-or-later
//
// Driving the popup's Settings/Account toggles to a target state. Every helper
// here works around the same thing: the popup paints its defaults before the
// persisted settings merge in, and the per-site section collapses the moment no
// site is excluded - so a plain `setChecked` waits on a node that may be gone.
import { type BrowserContext, expect, type Page } from "@playwright/test";
import { enMessage } from "./auth-signin";
import { openPopup } from "./extension-pages";

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

// Set a settings checkbox (by accessible name) in the popup to a target state,
// retrying since the popup paints defaults before merging persisted settings.
export async function setPopupCheckbox(context: BrowserContext, opts: { tab: "Settings" | "Account"; name: string; checked: boolean }): Promise<void> {
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
