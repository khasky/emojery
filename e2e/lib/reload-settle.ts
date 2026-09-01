// SPDX-License-Identifier: GPL-3.0-or-later

import type { Page } from "@playwright/test";

// Post-reload settle: the remount and its re-fetches expose no observable event
// to await, so give them a fixed beat before the caller reads or polls.
export async function reloadAndSettle(page: Page, settleMs: number): Promise<void> {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(settleMs);
}
