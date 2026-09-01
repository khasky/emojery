// SPDX-License-Identifier: GPL-3.0-or-later
//
// Virtual-screen-reader pass over the Picker: what an AT user hears - roles,
// accessible names, pressed state, and the search live region - in a real
// WebKit render. A DOM-tree surrogate for NVDA/VoiceOver: it validates the
// accessibility tree and live-region wiring, not vendor-specific quirks, so a
// manual screen-reader pass per release is still worthwhile.

import { virtual } from "@guidepup/virtual-screen-reader";
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { getEmojiLabel } from "../shared/emoji-meta";
import { t } from "../shared/i18n";
import { CATEGORIES } from "../shared/reactions";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { PICKER_STYLESHEET } from "./mount-shadow";
import { Picker } from "./picker";

let chromeShim: ChromeShimHandle;
let container: HTMLDivElement;
let portalRoot: HTMLDivElement;
let styleEl: HTMLStyleElement;

function mountPicker(): void {
  render(
    h(Picker, {
      initial: {
        value: { counts: {}, total: 0, loaded: 0, hasMore: false },
        myReaction: null,
        isAuthed: true,
      },
      onPick: () => true,
      onSignIn: () => {},
      portalRoot,
    }),
    container,
  );
}

async function openPopover(): Promise<void> {
  await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
  await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).not.toBeNull();
}

beforeEach(() => {
  chromeShim = installChromeShim();
  container = document.createElement("div");
  portalRoot = document.createElement("div");
  document.body.append(container, portalRoot);
  styleEl = document.createElement("style");
  styleEl.textContent = PICKER_STYLESHEET;
  document.head.appendChild(styleEl);
});

afterEach(async () => {
  await virtual.stop().catch(() => {});
  render(null, container);
  container.remove();
  portalRoot.remove();
  styleEl.remove();
  chromeShim.uninstall();
});

describe("Picker - virtual screen reader", () => {
  it("announces the closed trigger as a named button", async () => {
    mountPicker();
    await virtual.start({ container });
    for (let i = 0; i < 4; i++) await virtual.next();
    const heard = (await virtual.spokenPhraseLog()).join(" | ");
    expect(heard).toContain("button");
    expect(heard).toContain(t("pickerAddReaction"));
  });

  it("walks the open popover: dialog name, search box, labelled pressable emojis", async () => {
    mountPicker();
    await openPopover();
    await virtual.start({ container: portalRoot });
    // Enough steps to get past the dialog, search row and category bar into the grid.
    for (let i = 0; i < 30; i++) await virtual.next();
    const heard = (await virtual.spokenPhraseLog()).join(" | ");
    expect(heard).toContain(t("pickerDialogAria"));
    expect(heard).toContain(t("pickerSearchAriaLabel"));
    const firstEmojiLabel = getEmojiLabel(CATEGORIES[0]!.emojis[0]!);
    expect(firstEmojiLabel).not.toBe("");
    expect(heard).toContain(firstEmojiLabel);
    // aria-pressed on grid emojis reaches the tree ("not pressed" while unreacted).
    expect(heard).toContain("not pressed");
  });

  it("announces empty search results through the live region", async () => {
    mountPicker();
    await openPopover();
    await virtual.start({ container: portalRoot });
    const search = portalRoot.querySelector<HTMLInputElement>(".khasky-emojery-search")!;
    await userEvent.fill(search, "zzzzzz");
    // The sr-only role="status" region must announce the no-match state without
    // the user leaving the search box.
    await expect.poll(async () => (await virtual.spokenPhraseLog()).join(" | "), { timeout: 5000 }).toContain(t("pickerNoMatches", "zzzzzz"));
  });
});
