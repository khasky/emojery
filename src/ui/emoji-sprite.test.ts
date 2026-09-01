// SPDX-License-Identifier: GPL-3.0-or-later
//
// The sprite <img> is placed into DOM the host page can read (the light-DOM animation layer,
// the open shadow roots), so its URL must never carry the per-install extension origin that
// Firefox and Safari randomize. Extension-owned rendering only; no supported-site DOM, per
// CONTRIBUTING.md. The load probe itself is covered in WebKit by emoji-sprite.browser.test.tsx.

import { afterEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../test/cold-module-reset";

allowColdModuleReset();

const MOZ_ORIGIN = "moz-extension://8b1d3f0a-6c2e-4a71-9d55-0f3a2b6c8e17";

// One fresh module per case: the resolved URL and the probe verdict are memoized for the
// life of the module.
async function loadSpriteAt(extensionOrigin: string) {
  vi.resetModules();
  vi.stubGlobal("chrome", { runtime: { getURL: (path: string) => `${extensionOrigin}/${path}` } });
  return import("./emoji-sprite");
}

// The re-serve path the extension-origin browsers take: a content-script fetch of the
// packaged sheet, handed to createObjectURL. `mintedOrigin` is what the engine mints it
// against - the page on Gecko/WebKit, which is the whole point of the detour.
function stubSheetMint(mintedOrigin: string) {
  const revoked: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(new Blob([new Uint8Array([0])], { type: "image/webp" }))),
  );
  URL.createObjectURL = () => `blob:${mintedOrigin}/8f14e45f-ea0d-4b3a-9f1c-2c6b7a0d5e11`;
  URL.revokeObjectURL = (url: string) => revoked.push(url);
  return revoked;
}

function spriteImgOf(node: Node): HTMLImageElement | null {
  return (node as HTMLElement).querySelector<HTMLImageElement>("img.khasky-emojery-emoji-img");
}

afterEach(() => vi.unstubAllGlobals());

describe("emoji sprite URL exposure", () => {
  it.each([MOZ_ORIGIN, "safari-web-extension://3F9C1A62-5B84-4E0D-9A77-2C6E8B04D135"])("keeps the per-install extension origin %s out of page DOM", async (extensionOrigin) => {
    const { EMOJI_SPRITE_MODE_ATTR, applyEmojiSpriteHost, createEmojiSpriteElement } = await loadSpriteAt(extensionOrigin);

    // Before the async page-origin re-serve resolves, the <img> renders src-less
    // (the settled probe back-fills it) - so no URL, extension-origin or
    // otherwise, is in the DOM yet.
    const rendered = createEmojiSpriteElement("🔥");
    expect(spriteImgOf(rendered)?.getAttribute("src") ?? null).toBeNull();
    expect((rendered as HTMLElement).outerHTML).not.toContain("extension://");
    // The glyph character is the fallback rendering, so the host must stay in text mode:
    // sprite mode hides it and would leave an empty cell with no <img> to crop.
    const host = document.createElement("div");
    applyEmojiSpriteHost(host);
    expect(host.getAttribute(EMOJI_SPRITE_MODE_ATTR)).toBe("text");
    expect(rendered.textContent).toBe("🔥");
  });

  it("still renders the sheet from an origin every install shares", async () => {
    const { createEmojiSpriteElement } = await loadSpriteAt("chrome-extension://emojery");

    expect(spriteImgOf(createEmojiSpriteElement("🔥"))?.getAttribute("src")).toBe("chrome-extension://emojery/emoji-sprite/emoji-sprite.webp");
  });

  it("re-serves the sheet under the page's own origin where the packaged URL cannot be shown", async () => {
    stubSheetMint(location.origin);
    const { createEmojiSpriteElement, preloadEmojiSprite } = await loadSpriteAt(MOZ_ORIGIN);

    // Rendered BEFORE the re-serve resolves: src-less now, back-filled by the probe.
    const early = createEmojiSpriteElement("🔥");
    expect(spriteImgOf(early)?.getAttribute("src") ?? null).toBeNull();

    preloadEmojiSprite();
    await vi.waitFor(() => expect(spriteImgOf(createEmojiSpriteElement("🔥"))?.getAttribute("src") ?? null).not.toBeNull());

    const rendered = createEmojiSpriteElement("🔥") as HTMLElement;
    expect(spriteImgOf(rendered)?.getAttribute("src")).toBe(`blob:${location.origin}/8f14e45f-ea0d-4b3a-9f1c-2c6b7a0d5e11`);
    expect(rendered.outerHTML).not.toContain("extension://");
    // The back-fill of `early`'s src happens when the LOAD PROBE settles, which
    // jsdom's inert <img> never does - the browser-mode suite covers that hop.
  });

  it("drops a blob an engine minted against the extension origin instead of leaking it", async () => {
    const revoked = stubSheetMint(MOZ_ORIGIN);
    const { createEmojiSpriteElement, preloadEmojiSprite } = await loadSpriteAt(MOZ_ORIGIN);

    preloadEmojiSprite();
    await vi.waitFor(() => expect(revoked).toHaveLength(1));

    expect(spriteImgOf(createEmojiSpriteElement("🔥"))).toBeNull();
  });
});
