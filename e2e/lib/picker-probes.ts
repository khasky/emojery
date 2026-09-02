// SPDX-License-Identifier: GPL-3.0-or-later
//
// Driving the injected picker from a live page: finding the trigger for a target
// key, opening it with a trusted user action, and reading back what the shadow DOM
// shows. Every helper takes a Page and plain values and reads no suite state.
import { type ElementHandle, expect, type Page } from "@playwright/test";
import { collectMountEvidence, debugEvidence, handleKnownInterstitials, scrollPassUntil, settlePage } from "./page-settle";
import { ACTIVE_IN_ROOT_SRC, DEEP_QUERY_ALL_SRC, IS_VISIBLE_RECT_SRC, MOUNTED_KEY_OF_SRC } from "./probe-src";
import { GRID_ITEM_SELECTOR, TRIGGER_SELECTOR } from "./selectors";
import { DEFAULT_SCROLL_STEPS, type MountEvidence, type PickedReaction, type SupportedSiteScenario } from "./site-evidence";
import { dismissLoginWalls } from "./site-walls";

// evaluateHandle always resolves to a handle, even for a null result: asElement()
// tells the two apart, and the empty handle leaks unless it is disposed.
export async function firstElementHandle(page: Page, probeSource: string): Promise<ElementHandle<HTMLElement> | null> {
  const handle = await page.evaluateHandle<HTMLElement | null>(probeSource);
  const element = handle.asElement() as ElementHandle<HTMLElement> | null;
  if (!element) await handle.dispose().catch(() => {});
  return element;
}

export async function findMatchingEmojeryTrigger(page: Page, site: SupportedSiteScenario): Promise<ElementHandle<HTMLElement> | null> {
  return firstElementHandle(
    page,
    `(() => {
    // Pattern comes from a suite fixture, never from input.
    // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
    const pattern = new RegExp(${JSON.stringify(site.mountKeyPattern)});
    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    ${MOUNTED_KEY_OF_SRC}
    const hosts = deepQueryAll(".khasky-emojery-host");
    for (const host of hosts) {
      const mountKey = mountedKeyOf(host);
      if (!mountKey || !pattern.test(mountKey)) continue;
      const trigger = host.shadowRoot?.querySelector("button.khasky-emojery-trigger, button.khasky-emojery-counter");
      if (!trigger) continue;
      trigger.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "auto",
      });
      if (isVisibleRect(trigger.getBoundingClientRect())) return trigger;
    }
    return null;
  })()`,
  );
}

// Scroll-and-wait for ANY visible trigger (optionally for one target key).
// E2E_HISTORY_TARGET_TIMEOUT_MS is named for the history-URL wait it was written
// for, but it budgets EVERY visible-trigger wait in the suite.
export async function waitForVisibleEmojeryTrigger(page: Page, site: SupportedSiteScenario, targetKey?: string): Promise<ElementHandle<HTMLElement> | null> {
  const trigger = await scrollPassUntil(
    page,
    site.scrollSteps ?? DEFAULT_SCROLL_STEPS,
    Date.now() + Number(process.env.E2E_HISTORY_TARGET_TIMEOUT_MS ?? 30_000),
    async (p) => {
      await handleKnownInterstitials(p, site);
      await dismissLoginWalls(p);
      // Dismissing an interstitial re-renders the feed, so a beat here keeps the next
      // probe off the teardown.
      await p.waitForTimeout(750);
    },
    () => findAnyVisibleEmojeryTrigger(page, targetKey),
    (found) => found !== null,
  );

  return trigger ?? (await findAnyVisibleEmojeryTrigger(page, targetKey));
}

async function findAnyVisibleEmojeryTrigger(page: Page, targetKey?: string): Promise<ElementHandle<HTMLElement> | null> {
  return firstElementHandle(
    page,
    `(() => {
    const expectedTargetKey = ${JSON.stringify(targetKey ?? null)};
    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    ${MOUNTED_KEY_OF_SRC}
    for (const host of deepQueryAll(".khasky-emojery-host")) {
      if (expectedTargetKey && mountedKeyOf(host) !== expectedTargetKey) continue;
      const trigger = host.shadowRoot?.querySelector("button.khasky-emojery-trigger, button.khasky-emojery-counter");
      if (!trigger) continue;
      trigger.scrollIntoView({
        block: "center",
        inline: "center",
        behavior: "auto",
      });
      if (isVisibleRect(trigger.getBoundingClientRect())) return trigger;
    }
    return null;
  })()`,
  );
}

// Keyboard activation goes through a LOCATOR. The picker replaces its own nodes -
// PickerTrigger swaps the trigger for a counter when the counts land, and the grid
// re-renders under a click the site's overlay ate - so an ElementHandle taken before
// that is detached by the time it is focused, which throws "elementHandle.focus:
// Element is not attached to the DOM" (a YouTube watch run died there). A locator
// re-resolves at action time, so the re-render costs one retry inside Playwright's own
// actionability loop and the test never sees it.
//
// Budget: openPickerWithVisibleUserAction runs on every expectOpenPickerGrid poll, so
// this must stay short enough not to stack up behind that poll's own timeout.
const KEYBOARD_FOCUS_TIMEOUT_MS = 5_000;

async function focusAndPress(page: Page, selector: string, key: string, hasText?: string | null): Promise<void> {
  const visible = page.locator(selector).filter({ visible: true });
  await (hasText ? visible.filter({ hasText }) : visible).first().focus({ timeout: KEYBOARD_FOCUS_TIMEOUT_MS });
  await page.keyboard.press(key);
}

// Bounded wait returning the LAST read either way, for wait stages whose real
// assertion lives downstream. Never wrap these in expect.poll(...).catch(), which
// reads as an assertion but cannot fail.
export async function pollForValue<T>(read: () => Promise<T>, until: (value: T) => boolean, timeoutMs: number, intervalMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!until(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    value = await read();
  }
  return value;
}

// The picker closes itself whenever its trigger moves under it (the scroll guard in
// usePopoverPosition), and a page still settling after a load scrolls on its own within a
// few hundred ms of the click - so the grid can vanish right after it opened.
// Reopen while polling. A picker that never opens still fails here.
async function expectOpenPickerGrid(page: Page, trigger: ElementHandle<HTMLElement>, message: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const options = await visibleReactionOptionCount(page);
        if (options > 0) return options;
        await openPickerWithVisibleUserAction(page, trigger);
        return visibleReactionOptionCount(page);
      },
      { message },
    )
    .toBeGreaterThan(0);
}

export async function openVisiblePickerAndReadSelectedReaction(page: Page, trigger: ElementHandle<HTMLElement>, expectedReaction: string): Promise<string | null> {
  try {
    await openPickerWithVisibleUserAction(page, trigger);
    await expectOpenPickerGrid(page, trigger, "History URL picker should open its visible reaction choices");

    // Wait stage only: the caller asserts the returned reaction, so a slow hydrate
    // falls through to that assertion.
    return pollForValue(
      () => selectedReactionInOpenPicker(page),
      (r) => r === expectedReaction,
      Number(process.env.E2E_HISTORY_REACTION_TIMEOUT_MS ?? 20_000),
    );
  } finally {
    await trigger.dispose().catch(() => {});
  }
}

export async function openPickerWithVisibleUserAction(page: Page, trigger: ElementHandle<HTMLElement>): Promise<void> {
  const pickerIsOpen = async (): Promise<boolean> => (await visibleReactionOptionCount(page)) > 0;

  await trigger.click({ timeout: 3_000 }).catch(() => {});
  if (await pickerIsOpen()) return;

  // The keyboard ladder re-resolves the trigger itself (see focusAndPress): the handle
  // above is the one the failed click already proved unreliable.
  await focusAndPress(page, TRIGGER_SELECTOR, "Enter");
  if (await pickerIsOpen()) return;
  await focusAndPress(page, TRIGGER_SELECTOR, " ");
}

export async function selectedReactionInOpenPicker(page: Page): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    const reactionTextOf = (el) => {
      const emoji = el.querySelector('span[aria-hidden="true"]')?.textContent ?? el.textContent ?? "";
      return emoji.trim() || null;
    };

    const selected = deepQueryAll('.khasky-emojery-breakdown-row[data-selected="true"], .khasky-emojery-grid-item[aria-pressed="true"], [data-mine="true"]').find((el) => isVisibleRect(el.getBoundingClientRect()));
    return selected ? reactionTextOf(selected) : null;
  })()`);
}

export async function pickReactionOnMatchingHost(page: Page, site: SupportedSiteScenario, evidence: MountEvidence): Promise<PickedReaction> {
  const trigger = await findMatchingEmojeryTrigger(page, site);
  expect(trigger, debugEvidence(evidence)).not.toBeNull();
  if (!trigger) throw new Error("Missing matching Emojery trigger");

  try {
    const targetKey = (await mountedKeyForTrigger(trigger)) ?? firstMatchingEvidenceTargetKey(site, evidence);
    expect(targetKey, debugEvidence(evidence)).not.toBeNull();
    if (!targetKey) throw new Error("Missing target key for matching trigger");

    // Two attempts: on a layout that keeps moving the popover (a YouTube watch page
    // re-lays its action row as the player and metadata fill in) the option click
    // times out on actionability and the keyboard fallback can land mid-re-render,
    // so the pick registers nowhere. A second pick either lands or proves it broken.
    let reaction: string | null = null;
    let observed: string | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await trigger.click({ timeout: 10_000 });
      } catch {
        // A platform dialog can drop over the feed after evidence collection
        // (Threads' login sheet intercepts pointer events over the whole post) -
        // dismiss it, then go through the keyboard ladder: an overlay the unwall sweep
        // does not recognize keeps intercepting pointer clicks for the full retry
        // window, while focus + Enter/Space reaches the trigger regardless.
        await page.keyboard.press("Escape").catch(() => {});
        await dismissLoginWalls(page);
        await page.waitForTimeout(1_000);
        await openPickerWithVisibleUserAction(page, trigger);
      }
      await expectOpenPickerGrid(page, trigger, "Authenticated picker should open its reaction grid");

      reaction = await clickFirstUnselectedReactionOption(page);
      expect(reaction, "A reaction option should be clicked").not.toBeNull();
      if (!reaction) throw new Error("Missing reaction option");
      // The pick MUST settle, but the counter-form trigger only shows the top emoji
      // trio, so on a well-reacted target a fresh account's pick may never surface on
      // the button (data-active flips, the trio stays). Read the button first. When it
      // cannot carry the emoji, reopen the picker and read there.
      observed = await pollForValue(
        () => selectedReactionOnMatchingHost(page, targetKey),
        (r) => r === reaction,
        10_000,
      );
      if (observed !== reaction) {
        const reopened = await findMatchingEmojeryTrigger(page, site);
        expect(reopened, "Trigger should survive the reaction pick").not.toBeNull();
        if (!reopened) throw new Error("Missing trigger after reaction pick");
        observed = await openVisiblePickerAndReadSelectedReaction(page, reopened, reaction);
        await page.keyboard.press("Escape").catch(() => {});
      }
      if (observed === reaction) break;
    }
    expect(observed, "Clicked reaction should settle on the visible button or in the reopened picker").toBe(reaction);
    if (!reaction) throw new Error("Missing reaction option");
    return { reaction, targetKey };
  } finally {
    await trigger.dispose().catch(() => {});
  }
}

export function firstMatchingEvidenceTargetKey(site: SupportedSiteScenario, evidence: MountEvidence): string | null {
  // Pattern comes from a suite fixture, never from input.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const pattern = new RegExp(site.mountKeyPattern);
  return evidence.hostSamples.find((host) => host.visible && host.mountKey && pattern.test(host.mountKey))?.mountKey ?? evidence.matchingAnchorKeys.find((key) => pattern.test(key)) ?? null;
}

// Source-string form so the anchor walk stays the ONE definition in probe-src.ts:
// a typed copy here silently drifted from it before.
async function mountedKeyForTrigger(trigger: ElementHandle<HTMLElement>): Promise<string | null> {
  return trigger.evaluate<string | null>(`(el) => {
    ${MOUNTED_KEY_OF_SRC}
    const root = el.getRootNode();
    const host = el.closest(".khasky-emojery-host") ?? (root instanceof ShadowRoot && root.host instanceof HTMLElement && root.host.classList.contains("khasky-emojery-host") ? root.host : null);
    return host ? mountedKeyOf(host) : null;
  }`);
}

export async function visibleReactionOptionCount(page: Page): Promise<number> {
  return page.evaluate<number>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    return deepQueryAll(".khasky-emojery-grid-item, .khasky-emojery-breakdown-row").filter((el) => isVisibleRect(el.getBoundingClientRect())).length;
  })()`);
}

export async function fillVisibleEmojiSearch(page: Page, query: string): Promise<void> {
  const input = await findVisibleEmojiSearchInput(page);
  expect(input, "Picker search input should be visible").not.toBeNull();
  if (!input) return;
  try {
    await input.fill(query);
  } finally {
    await input.dispose().catch(() => {});
  }
}

export async function expectVisibleSearchFocused(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate<boolean>(`(() => {
          ${DEEP_QUERY_ALL_SRC}
          ${IS_VISIBLE_RECT_SRC}
          const input = deepQueryAll(".khasky-emojery-search").find((el) => isVisibleRect(el.getBoundingClientRect()));
          if (!input) return false;
          const root = input.getRootNode();
          return root instanceof ShadowRoot ? root.activeElement === input : document.activeElement === input;
        })()`),
      { message: "Opening the picker should focus its visible search input" },
    )
    .toBe(true);
}

export async function expectVisibleEmojiGridOption(page: Page, reaction: string): Promise<void> {
  await expect
    .poll(() => visibleEmojiGridOptionCount(page, reaction), {
      message: `Picker search should show ${reaction}`,
      timeout: 15_000,
    })
    .toBeGreaterThan(0);
}

export async function expectFocusedEmojiGridOption(page: Page, reaction: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate<string | null>(`(() => {
          ${ACTIVE_IN_ROOT_SRC}
          ${IS_VISIBLE_RECT_SRC}
          const active = activeInRoot(document);
          if (!(active instanceof HTMLElement)) return null;
          if (!active.classList.contains("khasky-emojery-grid-item")) return null;
          if (!isVisibleRect(active.getBoundingClientRect())) return null;
          return (active.textContent ?? "").trim() || null;
        })()`),
      { message: `Keyboard focus should move to ${reaction}` },
    )
    .toBe(reaction);
}

export async function expectFocusedElementHasVisibleFocusRing(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate<boolean>(`(() => {
          ${ACTIVE_IN_ROOT_SRC}
          const active = activeInRoot(document);
          if (!(active instanceof HTMLElement)) return false;
          const style = getComputedStyle(active);
          const outlineWidth = Number.parseFloat(style.outlineWidth || "0");
          const outlineColor = style.outlineColor.toLowerCase();
          return style.outlineStyle !== "none" && outlineWidth > 0 && outlineColor !== "transparent" && outlineColor !== "rgba(0, 0, 0, 0)";
        })()`),
      { message: "Keyboard-focused picker control should show a visible focus ring" },
    )
    .toBe(true);
}

export async function expectFocusedEmojeryTrigger(page: Page, targetKey: string): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate<boolean>(`(() => {
          const expectedTargetKey = ${JSON.stringify(targetKey)};
          ${ACTIVE_IN_ROOT_SRC}
          ${IS_VISIBLE_RECT_SRC}
          ${MOUNTED_KEY_OF_SRC}
          const active = activeInRoot(document);
          if (!(active instanceof HTMLElement)) return false;
          if (!active.classList.contains("khasky-emojery-trigger") && !active.classList.contains("khasky-emojery-counter")) {
            return false;
          }
          if (!isVisibleRect(active.getBoundingClientRect())) return false;

          const root = active.getRootNode();
          const host = root instanceof ShadowRoot && root.host instanceof HTMLElement && root.host.classList.contains("khasky-emojery-host") ? root.host : active.closest(".khasky-emojery-host");
          return host ? mountedKeyOf(host) === expectedTargetKey : false;
        })()`),
      { message: "Closing the picker with keyboard should return focus to trigger" },
    )
    .toBe(true);
}

export async function clickVisibleEmojiGridOption(page: Page, reaction: string): Promise<void> {
  await expectVisibleEmojiGridOption(page, reaction);
  const option = await findVisibleEmojiGridOption(page, reaction);
  expect(option, `Picker should expose a visible ${reaction} option`).not.toBeNull();
  if (!option) return;
  try {
    await option.click({ timeout: 10_000 });
  } finally {
    await option.dispose().catch(() => {});
  }
}

async function visibleEmojiGridOptionCount(page: Page, reaction: string): Promise<number> {
  return page.evaluate<number>(`(() => {
    const expectedReaction = ${JSON.stringify(reaction)};
    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    return deepQueryAll(".khasky-emojery-grid-item").filter((el) => isVisibleRect(el.getBoundingClientRect()) && (el.textContent ?? "").trim() === expectedReaction).length;
  })()`);
}

export async function emojiGridOptionTexts(page: Page): Promise<string[]> {
  return page.evaluate<string[]>(`(() => {
    ${DEEP_QUERY_ALL_SRC}
    return deepQueryAll(".khasky-emojery-grid-item").map((el) => (el.textContent ?? "").trim()).filter((text) => text.length > 0);
  })()`);
}

async function findVisibleEmojiSearchInput(page: Page): Promise<ElementHandle<HTMLInputElement> | null> {
  const input = await firstElementHandle(
    page,
    `(() => {
    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    return deepQueryAll(".khasky-emojery-search").find((el) => isVisibleRect(el.getBoundingClientRect())) ?? null;
  })()`,
  );
  return input as ElementHandle<HTMLInputElement> | null;
}

async function findVisibleEmojiGridOption(page: Page, reaction: string): Promise<ElementHandle<HTMLElement> | null> {
  return firstElementHandle(
    page,
    `(() => {
    const expectedReaction = ${JSON.stringify(reaction)};
    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    return deepQueryAll(".khasky-emojery-grid-item").find((el) => isVisibleRect(el.getBoundingClientRect()) && (el.textContent ?? "").trim() === expectedReaction) ?? null;
  })()`,
  );
}

export async function clickFirstUnselectedReactionOption(page: Page): Promise<string | null> {
  const option = await firstElementHandle(
    page,
    `(() => {
    ${DEEP_QUERY_ALL_SRC}
    ${IS_VISIBLE_RECT_SRC}
    const gridItems = deepQueryAll(".khasky-emojery-grid-item");
    const visibleGridItems = gridItems.filter((el) => isVisibleRect(el.getBoundingClientRect()) && !!el.textContent?.trim());
    const gridItem = visibleGridItems.find((el) => el.getAttribute("aria-pressed") !== "true" && el.getAttribute("data-selected") !== "true") ?? visibleGridItems[0] ?? null;
    if (gridItem) return gridItem;

    const breakdownRows = deepQueryAll(".khasky-emojery-breakdown-row");
    const visibleBreakdownRows = breakdownRows.filter((el) => isVisibleRect(el.getBoundingClientRect()) && !!el.textContent?.trim());
    return visibleBreakdownRows.find((el) => el.getAttribute("data-selected") !== "true") ?? visibleBreakdownRows[0] ?? null;
  })()`,
  );
  if (!option) return null;
  try {
    const reaction = await option.evaluate((el) => {
      const emoji = el.querySelector<HTMLElement>('span[aria-hidden="true"]')?.textContent ?? el.textContent ?? "";
      return emoji.trim() || null;
    });
    try {
      await option.click({ timeout: 5_000 });
    } catch {
      // A site overlay behind the popover (a YouTube video ad) makes Playwright's
      // pointer hit-target check spin until timeout even though the option paints on
      // top. Synthetic el.click() is a dead end, since handlePick is isTrusted-gated,
      // so activate via keyboard for a trusted click. The option is addressed by its
      // own glyph across the two surfaces findVisibleEmojiGridOption picks from, so a
      // re-render under the failed click re-resolves at action time.
      await focusAndPress(page, `${GRID_ITEM_SELECTOR}, .khasky-emojery-breakdown-row`, " ", reaction);
    }
    return reaction;
  } finally {
    await option.dispose().catch(() => {});
  }
}

export async function selectedReactionOnMatchingHost(page: Page, targetKey: string): Promise<string | null> {
  return page.evaluate<string | null>(`(() => {
    const expectedTargetKey = ${JSON.stringify(targetKey)};
    ${DEEP_QUERY_ALL_SRC}
    ${MOUNTED_KEY_OF_SRC}
    for (const host of deepQueryAll(".khasky-emojery-host")) {
      const key = mountedKeyOf(host);
      if (key !== expectedTargetKey) continue;

      const selected = host.shadowRoot?.querySelector('[data-mine="true"]');
      const selectedText = selected?.textContent?.trim();
      if (selectedText) return selectedText;

      const activeIcon = host.shadowRoot?.querySelector('button[data-active="true"] .khasky-emojery-trigger-icon');
      const activeText = activeIcon?.textContent?.trim();
      if (activeText) return activeText;
    }
    return null;
  })()`);
}

export async function waitForMountedTargetKey(page: Page, targetKey: string, site: SupportedSiteScenario, timeoutMs = Number(process.env.E2E_SITE_TIMEOUT_MS ?? 70_000)): Promise<void> {
  const found = await scrollPassUntil(
    page,
    site.scrollSteps ?? DEFAULT_SCROLL_STEPS,
    Date.now() + timeoutMs,
    (p) => settlePage(p, site),
    async () => {
      if (await scrollMountedAnchorIntoView(page, targetKey)) {
        await settlePage(page, site);
      }
      return page.evaluate<boolean>(`(() => {
        const expectedTargetKey = ${JSON.stringify(targetKey)};
        ${DEEP_QUERY_ALL_SRC}
        ${MOUNTED_KEY_OF_SRC}
        for (const host of deepQueryAll(".khasky-emojery-host")) {
          if (mountedKeyOf(host) !== expectedTargetKey) continue;
          host.scrollIntoView({
            block: "center",
            inline: "center",
            behavior: "auto",
          });
          return true;
        }
        return false;
      })()`);
    },
    (hit) => hit,
  );
  if (found) return;

  const evidence = await collectMountEvidence(page, site);
  expect(
    evidence.hostSamples.some((host) => host.mountKey === targetKey),
    debugEvidence(evidence),
  ).toBe(true);
}

async function scrollMountedAnchorIntoView(page: Page, targetKey: string): Promise<boolean> {
  return page.evaluate((expectedTargetKey) => {
    const anchors = Array.from(document.querySelectorAll<HTMLElement>("[data-khasky-emojery-mounted]"));
    const anchor = anchors.find((el) => el.getAttribute("data-khasky-emojery-mounted") === expectedTargetKey);
    if (!anchor) return false;
    anchor.scrollIntoView({
      block: "center",
      inline: "center",
      behavior: "auto",
    });
    return true;
  }, targetKey);
}
