// SPDX-License-Identifier: GPL-3.0-or-later
//
// Asserts on the `emojiSentiment` patch handed to `update`: moving an emoji
// between zones (click-to-move fallback), search over the neutral set, reset.

import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { DEFAULT_EMOJI_SENTIMENT } from "../../shared/native-actions";
import { DEFAULT_SETTINGS, type Settings } from "../../shared/storage";
import { mountContainer, requireEl, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim } from "../../test/chrome-shim";
// Real popup styles, like the other popup browser tests: unstyled, the search
// icon SVG has no intrinsic size and Gecko lays it out huge, covering the chips.
// @ts-expect-error side-effect css import, resolved by the browser-mode Vite server
import "./popup.css";
import { EmojiSentimentEditor } from "./popup-emoji-sentiment";

let chromeShim: ChromeShimHandle;
let container: HTMLDivElement;
let patches: Partial<Settings>[];

function makeSettings(): Settings {
  return {
    ...DEFAULT_SETTINGS,
    autoTriggerNative: true,
    emojiSentiment: {
      positive: [...DEFAULT_EMOJI_SENTIMENT.positive],
      negative: [...DEFAULT_EMOJI_SENTIMENT.negative],
    },
  };
}

function mount(settings: Settings): void {
  render(
    h(EmojiSentimentEditor, {
      settings,
      update: async (patch: Partial<Settings>) => {
        patches.push(patch);
      },
    }),
    container,
  );
}

const zone = (dest: string): HTMLElement => requireEl(container, `[data-zone="${dest}"]`);

function chipIn(dest: string, emoji: string): HTMLButtonElement | null {
  return [...zone(dest).querySelectorAll<HTMLButtonElement>(".sentiment-chip")].find((b) => b.textContent?.includes(emoji)) ?? null;
}

// Select a chip and wait for the re-render to commit. Native click, not
// userEvent: the chip's aria-label swaps from the emoji char to its localized
// name when the lazy emoji-meta load lands, and userEvent's element->locator
// conversion (by label) loses that race. Preact renders async, so the selected
// state is polled rather than read right after the click.
async function selectChip(dest: string, emoji: string): Promise<void> {
  const chip = chipIn(dest, emoji);
  if (!chip) throw new Error(`${emoji} chip missing`);
  chip.click();
  await vi.waitFor(() => {
    if (chipIn(dest, emoji)?.getAttribute("aria-pressed") !== "true") throw new Error(`${emoji} chip not selected yet`);
  });
}

beforeEach(() => {
  chromeShim = installChromeShim();
  patches = [];
  container = mountContainer();
});

afterEach(() => {
  unmountContainer(container);
  chromeShim.uninstall();
});

describe("EmojiSentimentEditor", () => {
  it("renders the three zones with the default lists", () => {
    mount(makeSettings());
    expect(chipIn("positive", "👍")).not.toBeNull();
    expect(chipIn("negative", "👎")).not.toBeNull();
    // 🤖 is in neither default list -> neutral.
    expect(chipIn("neutral", "🤖")).not.toBeNull();
  });

  it("click-to-move: select an emoji, then a zone title, patches the lists", async () => {
    mount(makeSettings());
    await selectChip("positive", "👍");

    const negativeTitle = zone("negative").querySelector<HTMLButtonElement>(".sentiment-zone-title");
    if (!negativeTitle) throw new Error("negative zone title missing");
    expect(negativeTitle.disabled).toBe(false);
    await userEvent.click(negativeTitle);

    expect(patches).toHaveLength(1);
    const sentiment = patches[0]?.emojiSentiment;
    expect(sentiment?.positive).not.toContain("👍");
    expect(sentiment?.negative).toContain("👍");
    expect(sentiment?.negative).toContain("👎");
    expect(sentiment?.positive).toContain("❤️");
  });

  it("click-to-move: a tap anywhere in the zone body moves too, once", async () => {
    mount(makeSettings());
    await selectChip("positive", "👍");
    // Click the zone body itself - empty padding area, not a chip (a chip
    // click means "change the selection", so it must NOT move).
    zone("negative").click();
    expect(patches).toHaveLength(1);
    expect(patches[0]?.emojiSentiment?.negative).toContain("👍");
  });

  it("moving to neutral just removes the emoji from both lists", async () => {
    mount(makeSettings());
    await selectChip("positive", "👍");
    const neutralTitle = zone("neutral").querySelector<HTMLButtonElement>(".sentiment-zone-title");
    if (!neutralTitle) throw new Error("neutral zone title missing");
    await userEvent.click(neutralTitle);

    const sentiment = patches[0]?.emojiSentiment;
    expect(sentiment?.positive).not.toContain("👍");
    expect(sentiment?.negative).not.toContain("👍");
  });

  it("drop onto a zone moves the dragged emoji", () => {
    mount(makeSettings());
    const dt = new DataTransfer();
    dt.setData("text/plain", "🤖");
    zone("positive").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: dt }));
    expect(patches).toHaveLength(1);
    expect(patches[0]?.emojiSentiment?.positive).toContain("🤖");
  });

  it("search narrows the neutral grid", async () => {
    mount(makeSettings());
    const input = zone("neutral").querySelector<HTMLInputElement>("input[type=search]");
    if (!input) throw new Error("neutral search input missing");
    await userEvent.fill(input, "robot");
    expect(chipIn("neutral", "🤖")).not.toBeNull();
    const chips = zone("neutral").querySelectorAll(".sentiment-chip");
    expect(chips.length).toBeLessThan(20);
  });

  it("reset restores the default lists", async () => {
    const settings = makeSettings();
    settings.emojiSentiment = { positive: ["🤖"], negative: [] };
    mount(settings);
    const reset = container.querySelector<HTMLButtonElement>(".sentiment-reset");
    if (!reset) throw new Error("reset button missing");
    await userEvent.click(reset);
    expect(patches[0]?.emojiSentiment).toEqual({
      positive: [...DEFAULT_EMOJI_SENTIMENT.positive],
      negative: [...DEFAULT_EMOJI_SENTIMENT.negative],
    });
  });
});
