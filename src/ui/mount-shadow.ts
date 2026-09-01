// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shadow-root plumbing for the injected UI: the shared picker stylesheet and the
// fixed-position overlay host the picker portals into. Apart from mount.ts (the mount
// lifecycle): these own only DOM/stylesheet setup and hold no mount state.

import { OVERLAY_HOST_CLASS } from "../shared/dom";
import { applyEmojiSpriteHost, emojiSpriteCss, PICKER_SPRITE_SCOPE } from "./emoji-sprite";
import pickerCss from "./picker.css?raw";
import { registerThemedHost } from "./themed-hosts";

/** Everything a picker shadow root needs - picker.css alone omits the sprite rules. */
export const PICKER_STYLESHEET = pickerCss + emojiSpriteCss(PICKER_SPRITE_SCOPE);

let sharedSheet: CSSStyleSheet | null = null;

function getSharedSheet(): CSSStyleSheet | null {
  if (typeof CSSStyleSheet === "undefined") return null;
  if (sharedSheet) return sharedSheet;
  try {
    sharedSheet = new CSSStyleSheet();
    sharedSheet.replaceSync(PICKER_STYLESHEET);
    return sharedSheet;
  } catch {
    return null;
  }
}

export function appendPickerStyles(shadow: ShadowRoot): void {
  const sheet = getSharedSheet();
  if (sheet && "adoptedStyleSheets" in shadow) {
    try {
      shadow.adoptedStyleSheets = [...shadow.adoptedStyleSheets, sheet];
      return;
    } catch {}
  }
  const style = document.createElement("style");
  style.textContent = PICKER_STYLESHEET;
  shadow.appendChild(style);
}

let overlayRoot: HTMLDivElement | null = null;
export function getOverlayRoot(): HTMLDivElement {
  if (overlayRoot?.isConnected) return overlayRoot;
  const host = document.createElement("div");
  host.className = OVERLAY_HOST_CLASS;
  host.style.cssText = "position: fixed; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 2147483647;";
  document.body.appendChild(host);
  registerThemedHost(host);
  applyEmojiSpriteHost(host);
  const shadow = host.attachShadow({ mode: "open" });
  appendPickerStyles(shadow);
  overlayRoot = document.createElement("div");
  overlayRoot.style.cssText = "pointer-events: auto;";
  shadow.appendChild(overlayRoot);
  return overlayRoot;
}
