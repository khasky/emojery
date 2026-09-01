// SPDX-License-Identifier: GPL-3.0-or-later
//
// Wires the generated emoji sprite sheet into the picker's shadow-DOM hosts: stamps each
// host with the sheet geometry as CSS variables (they inherit through the shadow boundary),
// resolves a page-safe URL for the sheet, and decides whether to use the sprite at all - the
// native glyph renders by default, switching to the sprite sheet only once a one-time probe
// confirms it is loadable. Firefox/Safari apply the *page's* CSP to content-script DOM, so a
// strict-CSP site can block the image; the picker then keeps the OS-font glyphs it always
// showed - never empty boxes.

import { REACTIONS } from "../shared/reactions";
import { SPRITE_COLS, SPRITE_FILE, SPRITE_ROWS } from "./__generated__/emoji-sprite-map";

export const EMOJI_SPRITE_MODE_ATTR = "data-khasky-emojery-emoji";

interface SpriteCssScope {
  /** Prefix for the default (OS-font) rules. Empty inside a shadow root. */
  base: string;
  /** Prefix matching a host already switched to sprite mode. */
  sprite: string;
}

/** Scope of the picker's shadow roots; the animation layer builds its own from its layer id. */
export const PICKER_SPRITE_SCOPE: SpriteCssScope = { base: "", sprite: `:host([${EMOJI_SPRITE_MODE_ATTR}="sprite"])` };

/** The sprite rules for one scope - the single definition the picker stylesheet
 *  and the light-DOM animation layer both render from. Default: sheet hidden, OS
 *  emoji font shows. Sprite mode sizes the <img> so one cell is 1em and shifts it
 *  by (col,row), showing only that window at any inherited font-size - an <img>
 *  downscales sharper than a background-image - and sr-hides the glyph character,
 *  which stays in the DOM for accessibility, copy/paste and e2e textContent
 *  selectors. Both rules require the <img>: an emoji rendered before the sheet URL
 *  resolved (Firefox/Safari mint theirs asynchronously, see below) keeps its glyph
 *  rather than clipping an empty box. */
export function emojiSpriteCss(scope: SpriteCssScope): string {
  return `
${scope.base} .khasky-emojery-emoji {
  display: inline;
}
${scope.base} .khasky-emojery-emoji-img {
  display: none;
}
${scope.sprite} .khasky-emojery-emoji:has(> .khasky-emojery-emoji-img) {
  display: inline-block;
  position: relative;
  width: 1em;
  height: 1em;
  overflow: hidden;
  vertical-align: middle;
}
${scope.sprite} .khasky-emojery-emoji-img {
  display: block;
  position: absolute;
  left: calc(var(--khasky-emojery-col) * -1em);
  top: calc(var(--khasky-emojery-row) * -1em);
  width: calc(var(--khasky-emojery-sprite-cols) * 1em);
  height: calc(var(--khasky-emojery-sprite-rows) * 1em);
  /* Defeat any inherited \`img { max-width: 100% }\` so the oversized sheet isn't shrunk. */
  max-width: none;
  pointer-events: none;
}
${scope.sprite} .khasky-emojery-emoji:has(> .khasky-emojery-emoji-img) > .khasky-emojery-emoji-char {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  pointer-events: none;
}
`;
}

type Mode = "text" | "sprite";

interface EmojiSpriteCell {
  col: number;
  row: number;
  url: string | null;
}

// Hosts whose shadow tree renders emoji. Tracked only until the one-time probe settles,
// so it can flip every registered host the instant the sheet loads - including hosts
// still detached at registration (doMount stamps the host before inserting it). Once
// settled, new hosts are stamped with the final mode directly and no longer tracked.
const spriteHosts = new Set<HTMLElement>();
// Sheet <img>s created before the URL resolved. Chrome resolves it synchronously
// (chrome-extension:// passes the allowlist), but Firefox/Safari mint a page-origin
// blob ASYNCHRONOUSLY - and a counter chip rendered from cached counts beats that
// resolution on every warm load. Such an emoji got no <img> at all, so the sprite
// CSS (keyed on `:has(> img)`) could never apply and it stayed an OS-font glyph
// for the life of the page. The <img> is therefore always created and back-filled
// here the moment the probe settles. Cleared on settle, like spriteHosts.
const pendingSpriteImgs = new Set<HTMLImageElement>();
let mode: Mode = "text";
let probeStarted = false;
let probeSettled = false;
let resolvedUrl: string | undefined;

// The sheet URL lands in DOM the host page can read - the animation layer is a plain <div>
// on document.body and the trigger/picker shadow roots are open - so it must never carry an
// origin that is unique to this install. Firefox (moz-extension://) and Safari
// (safari-web-extension://) randomize the extension origin per install precisely so a page
// cannot fingerprint or correlate one browser across sites, and every supported site would
// otherwise read the same value. Allowlist, so an unfamiliar scheme keeps the OS-font glyphs
// instead of leaking: the document's own origin (extension pages - the popup renders the
// sheet on every browser, no web page can read its DOM), Chrome/Edge's chrome-extension://
// id (the same for every install, and the injected khasky-emojery-* markup already announces
// the extension), a blob minted against the document's own origin (see mintPageOriginUrl),
// and origin-less data: URLs.
function pageSafeSpriteUrl(url: string): boolean {
  return url.startsWith(`${location.origin}/`) || url.startsWith(`blob:${location.origin}/`) || url.startsWith("chrome-extension://") || url.startsWith("data:");
}

// Packaged URL of the sheet; null outside an extension context (unit tests).
function extensionSpriteUrl(): string | null {
  try {
    return typeof chrome !== "undefined" && chrome.runtime?.getURL ? chrome.runtime.getURL(SPRITE_FILE) : null;
  } catch {
    return null;
  }
}

// The URL the rendered <img> may carry. Memoized over three states - undefined is "not
// resolved yet", "" is "resolved, nothing usable", non-empty is the URL - because it is
// stable for the life of the document and must not be re-derived once it came back unusable.
function spriteImageUrl(): string | null {
  if (resolvedUrl === undefined) {
    const packaged = extensionSpriteUrl();
    // Deliberately NOT settled to "" when the packaged URL fails the allowlist: preloadEmojiSprite
    // fills in a page-origin blob for that case, and it has not run yet.
    if (packaged && pageSafeSpriteUrl(packaged)) resolvedUrl = packaged;
  }
  return resolvedUrl || null;
}

// Where the packaged URL is an install fingerprint, the content script re-serves the sheet
// under the PAGE's origin instead: a content-script fetch keeps extension privileges (the
// page's CSP does not gate it), and the object URL Gecko mints from the result is
// `blob:<page origin>/<random>` - verified in Firefox 153 - so the page reads back nothing
// that is stable across sites or installs. Awaited once, by the probe.
async function mintPageOriginUrl(): Promise<string | null> {
  const packaged = extensionSpriteUrl();
  if (!packaged || typeof fetch === "undefined" || typeof URL?.createObjectURL !== "function") return null;
  try {
    const res = await fetch(packaged);
    if (!res.ok) return null;
    const url = URL.createObjectURL(await res.blob());
    if (pageSafeSpriteUrl(url)) return url;
    // An engine that mints the blob against the EXTENSION's origin would leak the very
    // identifier this path exists to hide; drop it and keep the OS-font glyphs.
    URL.revokeObjectURL(url);
    return null;
  } catch {
    return null;
  }
}

// emoji -> linear cell index, derived rather than shipped: the sheet is rasterized in
// palette order (scripts/build-emoji-sprite.mjs reads the same categories file), so the
// index IS the position in REACTIONS. Built once, lazily, and only from data every bundle
// that renders emoji already carries - a shipped table would be a second copy of every
// palette string in each content script. SPRITE_PALETTE_SIGNATURE pins the two orders
// together; emoji-sprite-coverage.test.ts is where they are checked.
let spriteIndex: Map<string, number> | null = null;

function indexOfEmoji(emoji: string): number | undefined {
  if (!spriteIndex) spriteIndex = new Map(REACTIONS.map((value, i) => [value, i]));
  return spriteIndex.get(emoji);
}

export function emojiSpriteCell(emoji: string): EmojiSpriteCell | null {
  const index = indexOfEmoji(emoji);
  if (index === undefined) return null;

  const col = index % SPRITE_COLS;
  const row = (index - col) / SPRITE_COLS;
  return { col, row, url: spriteImageUrl() };
}

/** Whether an emoji rendered right now should still carry a (src-less) sheet <img>:
 *  the URL is not resolved yet but may still arrive. Registered via
 *  registerPendingSpriteImg so settleProbe can back-fill the src. */
export function spriteUrlPending(): boolean {
  return !probeSettled;
}

export function registerPendingSpriteImg(img: HTMLImageElement): void {
  if (!probeSettled) pendingSpriteImgs.add(img);
}

export function createEmojiSpriteElement(emoji: string): Node {
  const cell = emojiSpriteCell(emoji);
  if (!cell) return document.createTextNode(emoji);

  const root = document.createElement("span");
  root.className = "khasky-emojery-emoji";
  root.style.setProperty("--khasky-emojery-col", String(cell.col));
  root.style.setProperty("--khasky-emojery-row", String(cell.row));

  if (cell.url || spriteUrlPending()) {
    const img = document.createElement("img");
    img.className = "khasky-emojery-emoji-img";
    if (cell.url) img.src = cell.url;
    else registerPendingSpriteImg(img);
    img.alt = "";
    img.decoding = "async";
    img.draggable = false;
    root.appendChild(img);
  }

  const char = document.createElement("span");
  char.className = "khasky-emojery-emoji-char";
  char.textContent = emoji;
  root.appendChild(char);
  return root;
}

// On success flip every tracked host, connected or not - a detached host keeps the
// attribute and CSS picks it up when it lands in the DOM. Mode never flips again.
// Pending imgs get their src in the same pass, so emoji rendered before the async
// URL resolution (see pendingSpriteImgs) upgrade to the sheet with their hosts.
function settleProbe(next: Mode): void {
  mode = next;
  probeSettled = true;
  if (next === "sprite") {
    const url = resolvedUrl;
    if (url) {
      for (const img of pendingSpriteImgs) img.src = url;
    }
    for (const host of spriteHosts) host.setAttribute(EMOJI_SPRITE_MODE_ATTR, "sprite");
  }
  pendingSpriteImgs.clear();
  spriteHosts.clear();
}

// Kick off the fetch+decode as soon as a page is known to want a trigger (mount.ts, right after the
// settings gate). Idempotent. Later - at the first host's applyEmojiSpriteHost - races the paint and
// visibly swaps glyphs a beat later; earlier - at content-script startup - pays the ~1 MB decode on
// every page of every supported host, including pages with no target at all.
//
// Probes the sheet once. A bare Image() load runs under the same page CSP the sprite will
// face, so onload/onerror is the authoritative gate: onerror (CSP-blocked / asset missing)
// keeps text mode, onload proves the sheet is usable. decode() is only a refinement on top -
// the sheet is a ~1 MB WebP, and flipping the instant onload fires flashed an empty trigger
// for a frame while the first paint was still rasterizing, so we prefer to wait for decode().
// But decode() rejects spuriously in some engines (WebKit rejects it with EncodingError even
// for a good, fully-loaded image); a rejection here must NOT fall back to text, since onload
// already proved the sheet loaded - it only means we take the one-frame flash.
export function preloadEmojiSprite(): void {
  if (probeStarted) return;
  probeStarted = true;
  void (async () => {
    const url = spriteImageUrl() ?? (await mintPageOriginUrl());
    resolvedUrl = url ?? "";
    if (!url || typeof Image === "undefined") {
      settleProbe("text");
      return;
    }
    const img = new Image();
    const toSprite = () => settleProbe("sprite");
    img.onload = () => {
      const decoding = img.decode?.();
      if (decoding) decoding.then(toSprite, toSprite);
      else toSprite();
    };
    img.onerror = () => settleProbe("text");
    img.src = url;
  })();
}

// Stamp the sheet geometry + current mode on a host. Idempotent - the animation layer re-applies it on every use.
export function applyEmojiSpriteHost(host: HTMLElement): void {
  host.style.setProperty("--khasky-emojery-sprite-cols", String(SPRITE_COLS));
  host.style.setProperty("--khasky-emojery-sprite-rows", String(SPRITE_ROWS));
  host.setAttribute(EMOJI_SPRITE_MODE_ATTR, mode);
  if (!probeSettled) spriteHosts.add(host);
  preloadEmojiSprite();
}
