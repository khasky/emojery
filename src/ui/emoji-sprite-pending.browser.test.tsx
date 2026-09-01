// SPDX-License-Identifier: GPL-3.0-or-later
//
// The extension-origin path (Firefox/Safari): the packaged sheet URL fails the
// page-safe allowlist, so the URL only exists after an async fetch->blob re-serve.
// An emoji rendered BEFORE that resolution must still upgrade to the sprite -
// this is the regression where a counter chip rendered from cached counts kept
// OS-font glyphs for the life of the page. Separate file from
// emoji-sprite.browser.test.tsx on purpose: that one resolves the URL
// synchronously (data: passes the allowlist), and the module's probe state is
// per-file.

import { h, render } from "preact";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { EmojiImg } from "./emoji-img";
import { applyEmojiSpriteHost, EMOJI_SPRITE_MODE_ATTR } from "./emoji-sprite";
import { PICKER_STYLESHEET } from "./mount-shadow";

const PNG_1X1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

let chromeShim: ChromeShimHandle;
const realFetch = globalThis.fetch;

beforeAll(() => {
  // A per-install extension origin: fails pageSafeSpriteUrl, forcing the async
  // page-origin blob mint. The stubbed fetch serves the real 1x1 PNG for it, so
  // createObjectURL mints a genuine, loadable blob: URL against the page origin.
  chromeShim = installChromeShim({ getURL: () => "moz-extension://0f3a2b6c-8e17-4a71-9d55-6c2e8b04d135/emoji-sprite.png" });
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === "string" && input.startsWith("moz-extension://")) return realFetch(PNG_1X1);
    return realFetch(input, init);
  };
});

afterAll(() => {
  globalThis.fetch = realFetch;
  chromeShim.uninstall();
});

describe("emoji sprite - async URL back-fill", () => {
  it("upgrades an emoji rendered before the sheet URL resolved", async () => {
    const host = document.createElement("div");
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PICKER_STYLESHEET;
    const mount = document.createElement("div");
    shadow.append(style, mount);
    document.body.append(host);

    // Rendered BEFORE the probe starts - models the counter chip on a warm load.
    render(h(EmojiImg, { emoji: "🔥" }), mount);
    const img = shadow.querySelector<HTMLImageElement>("img.khasky-emojery-emoji-img");
    expect(img, "the <img> renders src-less while the URL is pending").not.toBeNull();
    expect(img!.getAttribute("src")).toBeNull();

    applyEmojiSpriteHost(host); // kicks off the probe
    await expect.poll(() => host.getAttribute(EMOJI_SPRITE_MODE_ATTR)).toBe("sprite");

    expect(img!.getAttribute("src"), "the settled probe back-fills the src").toMatch(/^blob:/);
    const glyph = shadow.querySelector<HTMLElement>(".khasky-emojery-emoji")!;
    expect(getComputedStyle(glyph).display, "the sprite rules apply to the upgraded emoji").toBe("inline-block");
    expect(getComputedStyle(glyph).overflow).toBe("hidden");
    expect(getComputedStyle(img!).display).toBe("block");

    render(null, mount);
    host.remove();
  });
});
