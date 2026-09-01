// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../test/cold-module-reset";

allowColdModuleReset();

const LAYER_ID = "khasky-emojery-reaction-animations";
const SPRITE_ATTR = "data-khasky-emojery-emoji";

async function loadAnimations() {
  vi.resetModules();
  vi.stubGlobal("chrome", {
    runtime: {
      getURL: (path: string) => `chrome-extension://emojery/${path}`,
    },
  });

  class InstantImage {
    onload: (() => void) | null = null;

    set src(_value: string) {
      this.onload?.();
    }
  }

  vi.stubGlobal("Image", InstantImage);
  return import("./animations");
}

function expectSpriteEmoji(root: ParentNode, emoji: string): void {
  const rendered = root.querySelector<HTMLElement>(".khasky-emojery-emoji");
  expect(rendered).not.toBeNull();
  expect(rendered?.textContent).toBe(emoji);
  expect(rendered?.style.getPropertyValue("--khasky-emojery-col")).not.toBe("");
  expect(rendered?.style.getPropertyValue("--khasky-emojery-row")).not.toBe("");

  const img = rendered?.querySelector<HTMLImageElement>(".khasky-emojery-emoji-img");
  expect(img?.getAttribute("src")).toBe("chrome-extension://emojery/emoji-sprite/emoji-sprite.webp");
}

describe("reaction animation emoji rendering", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders click float emoji from the shared sprite sheet", async () => {
    const { playReactionClickFloat, resetReactionAnimationStateForTests } = await loadAnimations();
    resetReactionAnimationStateForTests();

    playReactionClickFloat("❤️", { x: 20, y: 30 });

    const layer = document.getElementById(LAYER_ID);
    expect(layer?.getAttribute(SPRITE_ATTR)).toBe("sprite");
    expectSpriteEmoji(document, "❤️");
  });

  it("renders page-open intro particles from the shared sprite sheet", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { maybePlayPublicReactionIntro, resetReactionAnimationStateForTests } = await loadAnimations();
    resetReactionAnimationStateForTests();

    maybePlayPublicReactionIntro({
      counts: { "👍": 2 },
      total: 2,
      loaded: 1,
      hasMore: false,
    });
    vi.advanceTimersByTime(1);

    const layer = document.getElementById(LAYER_ID);
    expect(layer?.getAttribute(SPRITE_ATTR)).toBe("sprite");
    expectSpriteEmoji(document, "👍");
  });
});
