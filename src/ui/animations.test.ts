// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANIMATION_LAYER_ID, EMOJI_CLASS, EMOJI_IMG_CLASS, SPRITE_COL_VAR, SPRITE_ROW_VAR } from "../shared/dom";
import { allowColdModuleReset } from "../test/cold-module-reset";
import { EMOJI_SPRITE_MODE_ATTR } from "./emoji-sprite";

allowColdModuleReset();

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
  const rendered = root.querySelector<HTMLElement>(`.${EMOJI_CLASS}`);
  expect(rendered).not.toBeNull();
  expect(rendered?.textContent).toBe(emoji);
  expect(rendered?.style.getPropertyValue(SPRITE_COL_VAR)).not.toBe("");
  expect(rendered?.style.getPropertyValue(SPRITE_ROW_VAR)).not.toBe("");

  const img = rendered?.querySelector<HTMLImageElement>(`.${EMOJI_IMG_CLASS}`);
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

    const layer = document.getElementById(ANIMATION_LAYER_ID);
    expect(layer?.getAttribute(EMOJI_SPRITE_MODE_ATTR)).toBe("sprite");
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

    const layer = document.getElementById(ANIMATION_LAYER_ID);
    expect(layer?.getAttribute(EMOJI_SPRITE_MODE_ATTR)).toBe("sprite");
    expectSpriteEmoji(document, "👍");
  });
});
