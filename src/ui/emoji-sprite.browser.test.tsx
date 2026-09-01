// SPDX-License-Identifier: GPL-3.0-or-later
//
// WebKit render test for the emoji sprite path: exercises the REAL `Image()` probe that
// flips the picker from text glyphs to the sprite sheet - jsdom can't (it doesn't load
// images). Extension-owned UI only; no supported-site DOM, per CONTRIBUTING.md.
// Separate file (not picker.browser.test.tsx) so emoji-sprite's module-level probe state
// starts fresh: each Vitest browser test file is its own context.

import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { EmojiImg } from "./emoji-img";
import { applyEmojiSpriteHost, EMOJI_SPRITE_MODE_ATTR } from "./emoji-sprite";
import { PICKER_STYLESHEET } from "./mount-shadow";

// A 1x1 transparent PNG - a real, loadable image so the probe's onload fires.
const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let chromeShim: ChromeShimHandle;
let host: HTMLElement;
let container: HTMLDivElement;

beforeEach(() => {
  // getURL resolves to a loadable asset, so the sprite probe flips into sprite
  // mode (the offline default "" would keep it on text glyphs).
  chromeShim = installChromeShim({ getURL: () => PNG_1X1 });
  host = document.createElement("div");
  container = document.createElement("div");
  document.body.append(host, container);
});

afterEach(() => {
  render(null, container);
  host.remove();
  container.remove();
  chromeShim.uninstall();
});

describe("emoji sprite - WebKit probe", () => {
  it("flips the host from text to sprite once the sheet loads", async () => {
    // A host registered while still detached models the first trigger, which
    // doMount stamps before inserting it. It must flip too, or the top post
    // is stuck on the native glyph while later posts get the sprite.
    const detached = document.createElement("div");
    applyEmojiSpriteHost(host);
    applyEmojiSpriteHost(detached);
    expect(host.getAttribute(EMOJI_SPRITE_MODE_ATTR)).toBe("text");
    expect(detached.getAttribute(EMOJI_SPRITE_MODE_ATTR)).toBe("text");

    await expect.poll(() => host.getAttribute(EMOJI_SPRITE_MODE_ATTR)).toBe("sprite");
    expect(detached.getAttribute(EMOJI_SPRITE_MODE_ATTR)).toBe("sprite");
  });

  it("EmojiImg renders an <img> at the resolved sprite URL, keeping the glyph fallback", () => {
    render(h(EmojiImg, { emoji: "🔥" }), container);

    const img = container.querySelector<HTMLImageElement>("img.khasky-emojery-emoji-img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(PNG_1X1);
    // The glyph stays in the DOM as the accessible / copyable fallback.
    expect(container.querySelector(".khasky-emojery-emoji-char")?.textContent).toBe("🔥");
  });

  // The crop rules are GENERATED (emojiSpriteCss) for two scopes - the picker's shadow root
  // and the animation layer. A malformed selector would parse away silently and ship an
  // uncropped sheet, so assert the picker scope actually applies in both modes.
  it("crops the sheet only while the host is in sprite mode", () => {
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PICKER_STYLESHEET;
    const mount = document.createElement("div");
    shadow.append(style, mount);
    render(h(EmojiImg, { emoji: "🔥" }), mount);

    const glyph = shadow.querySelector<HTMLElement>(".khasky-emojery-emoji")!;
    const img = shadow.querySelector<HTMLElement>(".khasky-emojery-emoji-img")!;

    host.setAttribute(EMOJI_SPRITE_MODE_ATTR, "text");
    expect(getComputedStyle(glyph).display, "text mode shows the OS glyph").toBe("inline");
    expect(getComputedStyle(img).display).toBe("none");

    host.setAttribute(EMOJI_SPRITE_MODE_ATTR, "sprite");
    expect(getComputedStyle(glyph).display, "sprite mode crops to a 1em window").toBe("inline-block");
    expect(getComputedStyle(glyph).overflow).toBe("hidden");
    expect(getComputedStyle(img).display).toBe("block");

    render(null, mount);
  });
});
