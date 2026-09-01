// SPDX-License-Identifier: GPL-3.0-or-later
//
// One target, one reaction: pick it, clear it, and assert what the picker shows
// back. A layer above lib/picker-probes.ts - the probes read and click, these
// compose a probe sequence into the action or assertion a scenario asks for.
// Every helper takes a Page and plain values and reads no suite state.
import { expect, type Page } from "@playwright/test";
import { clickVisibleEmojiGridOption, expectVisibleEmojiGridOption, fillVisibleEmojiSearch, openPickerWithVisibleUserAction, selectedReactionInOpenPicker, selectedReactionOnMatchingHost, visibleReactionOptionCount, waitForVisibleEmojeryTrigger } from "./picker-probes";
import type { PickedReaction, SupportedSiteScenario } from "./site-evidence";

// How long a picker read may keep re-opening before the reaction it expects is
// called missing. Generous: the read runs against a live third-party page whose
// counts hydrate on their own schedule.
const REACTION_POLL_TIMEOUT_MS = 15_000;

export async function pickReactionBySearchOnTarget(page: Page, site: SupportedSiteScenario, targetKey: string, reaction: string, query: string): Promise<PickedReaction> {
  const picked = await clickReactionBySearchOnTarget(page, site, targetKey, reaction, query);
  await expectSelectedReaction(page, site, targetKey, reaction);
  return picked;
}

export async function clickReactionBySearchOnTarget(page: Page, site: SupportedSiteScenario, targetKey: string, reaction: string, query: string): Promise<PickedReaction> {
  const trigger = await waitForVisibleEmojeryTrigger(page, site, targetKey);
  expect(trigger, `${site.label}: expected a visible Emojery trigger for ${targetKey}`).not.toBeNull();
  if (!trigger) throw new Error(`Missing visible Emojery trigger for ${targetKey}`);

  try {
    await openPickerWithVisibleUserAction(page, trigger);
    await expectVisibleReactionOptions(page);
    await fillVisibleEmojiSearch(page, query);
    await clickVisibleEmojiGridOption(page, reaction);
    return { reaction, targetKey };
  } finally {
    await trigger.dispose().catch(() => {});
  }
}

export async function clearReactionOnTarget(page: Page, site: SupportedSiteScenario, targetKey: string): Promise<void> {
  const current = await selectedReactionViaPicker(page, site, targetKey);
  if (!current) return;
  await clickReactionBySearchOnTarget(page, site, targetKey, current, current);
  await expectReactionOptionSelected(page, site, targetKey, current, false);
}

export async function expectSelectedReaction(page: Page, site: SupportedSiteScenario, targetKey: string, expected: string | null): Promise<void> {
  if (expected !== null) {
    const visibleOnButton = await selectedReactionOnMatchingHost(page, targetKey);
    if (visibleOnButton === expected) return;
  }

  await expect
    .poll(() => (expected === null ? selectedReactionViaPicker(page, site, targetKey) : selectedReactionViaPicker(page, site, targetKey, expected, expected)), {
      message: expected === null ? "Visible picker should show no selected user reaction" : `Visible picker should show ${expected} as selected`,
      timeout: REACTION_POLL_TIMEOUT_MS,
    })
    .toBe(expected);
}

export async function expectReactionOptionSelected(page: Page, site: SupportedSiteScenario, targetKey: string, reaction: string, selected: boolean): Promise<void> {
  await expect
    .poll(() => selectedReactionViaPicker(page, site, targetKey, reaction, reaction), {
      message: selected ? `Visible picker search result ${reaction} should be selected` : `Visible picker search result ${reaction} should not be selected`,
      timeout: REACTION_POLL_TIMEOUT_MS,
    })
    .toBe(selected ? reaction : null);
}

async function selectedReactionViaPicker(page: Page, site: SupportedSiteScenario, targetKey: string, query?: string, expectedVisibleReaction?: string): Promise<string | null> {
  const trigger = await waitForVisibleEmojeryTrigger(page, site, targetKey);
  if (!trigger) return null;
  try {
    await openPickerWithVisibleUserAction(page, trigger);
    await expectVisibleReactionOptions(page);
    if (query !== undefined) {
      await fillVisibleEmojiSearch(page, query);
      if (expectedVisibleReaction) {
        await expectVisibleEmojiGridOption(page, expectedVisibleReaction);
      }
    }
    return await selectedReactionInOpenPicker(page);
  } finally {
    await page.keyboard.press("Escape").catch(() => {});
    await trigger.dispose().catch(() => {});
  }
}

export async function expectVisibleReactionOptions(page: Page): Promise<void> {
  await expect
    .poll(() => visibleReactionOptionCount(page), {
      message: "Picker should show visible reaction choices",
    })
    .toBeGreaterThan(0);
}

export async function expectPickerClosed(page: Page): Promise<void> {
  await expect
    .poll(() => visibleReactionOptionCount(page), {
      message: "Picker should close its visible reaction choices",
    })
    .toBe(0);
}
