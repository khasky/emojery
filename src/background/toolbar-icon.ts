// SPDX-License-Identifier: GPL-3.0-or-later
//
// Toolbar-icon state: an alternate icon on the extension's own homepage, full-color on a
// supported site, greyscale everywhere else - a passive "does nothing here" cue. Greyscale
// is derived at runtime from the packaged color icons; the homepage icons ship as assets.
//
// State is read WITHOUT the broad `tabs` permission: host permissions cover the
// supported sites, emojery.app and the API origin, so a tab's `url` is populated
// for those and redacted (undefined) on every other page - unreadable means
// greyscale.
import { API_TIMEOUT_MS } from "../shared/config";
import { deadlineSignal } from "../shared/fetch-deadline";
import { isOwnHomepage } from "../shared/homepage";
import { detectSupportedSite } from "../shared/sites";
import { setToolbarIcon } from "../shared/webext";

const ICON_SIZES = [16, 32, 48, 128] as const;

const COLOR_ICON_PATH: Record<number, string> = {};
for (const size of ICON_SIZES) COLOR_ICON_PATH[size] = `icons/icon-${size}.png`;

const HOME_ICON_PATH: Record<number, string> = {};
for (const size of ICON_SIZES) HOME_ICON_PATH[size] = `icons/icon-home-${size}.png`;

export function isSupportedTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return false;
  }
  return detectSupportedSite(host) !== null;
}

type IconFrames = Record<number, ImageData>;

// Every variant is decoded ONCE per worker life and then set as imageData, with
// the packaged paths only as the no-canvas fallback. Path-based setIcon makes
// Chrome fetch the png inside the call, and that fetch fails around a worker's
// start and teardown (extension reload/update) - logged as an unchecked
// "Failed to set icon ... Failed to fetch" from a context our callback can no
// longer check. Pre-decoded frames need no fetch at call time.
interface IconVariant {
  paths: Record<number, string>;
  desaturate: boolean;
  frames: Promise<IconFrames | null> | null;
}

const homeVariant: IconVariant = { paths: HOME_ICON_PATH, desaturate: false, frames: null };
const colorVariant: IconVariant = { paths: COLOR_ICON_PATH, desaturate: false, frames: null };
const grayVariant: IconVariant = { paths: COLOR_ICON_PATH, desaturate: true, frames: null };

function decodedIcons(paths: Record<number, string>, desaturate: boolean): Promise<IconFrames | null> {
  if (typeof OffscreenCanvas === "undefined" || typeof createImageBitmap === "undefined") return Promise.resolve(null);
  return (async () => {
    const frames: IconFrames = {};
    for (const size of ICON_SIZES) {
      // Deadline matters despite the extension-local URL: the memoized promise
      // means a hang here would pin every later tab-icon update.
      const signal = deadlineSignal(API_TIMEOUT_MS);
      const blob = await (await fetch(chrome.runtime.getURL(paths[size] ?? ""), signal ? { signal } : {})).blob();
      const bitmap = await createImageBitmap(blob);
      const ctx = new OffscreenCanvas(size, size).getContext("2d");
      if (!ctx) return null;
      ctx.drawImage(bitmap, 0, 0, size, size);
      const frame = ctx.getImageData(0, 0, size, size);
      if (desaturate) {
        const px = frame.data;
        for (let i = 0; i < px.length; i += 4) {
          const luma = Math.round(0.299 * (px[i] ?? 0) + 0.587 * (px[i + 1] ?? 0) + 0.114 * (px[i + 2] ?? 0));
          px[i] = luma;
          px[i + 1] = luma;
          px[i + 2] = luma;
        }
      }
      frames[size] = frame;
    }
    return frames;
  })().catch(() => null);
}

// Fall back to the packaged paths if frames couldn't be produced - never blank the icon.
function setIconFramesForTab(decoded: Promise<IconFrames | null>, fallbackPath: Record<number, string>, tabId: number): void {
  void decoded.then((imageData) => {
    setToolbarIcon(imageData ? { imageData, tabId } : { path: fallbackPath, tabId });
  });
}

// A failed decode is not memoized (the fetch can flake around worker startup,
// and the next call should retry); the no-canvas engines return null cheaply
// via the typeof gate, so re-running them per call costs nothing.
function setVariantIconForTab(variant: IconVariant, tabId: number): void {
  variant.frames ??= decodedIcons(variant.paths, variant.desaturate).then((frames) => {
    if (!frames) variant.frames = null;
    return frames;
  });
  setIconFramesForTab(variant.frames, variant.paths, tabId);
}

export function applyToolbarIconForTab(tabId: number, url: string | undefined): void {
  if (isOwnHomepage(url)) {
    setVariantIconForTab(homeVariant, tabId);
    return;
  }
  if (isSupportedTabUrl(url)) {
    setVariantIconForTab(colorVariant, tabId);
    return;
  }
  setVariantIconForTab(grayVariant, tabId);
}
