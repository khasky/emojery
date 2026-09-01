// SPDX-License-Identifier: GPL-3.0-or-later
//
// Page-theme detection so the in-page picker matches the host site's
// light/dark palette instead of obeying only the OS preference. Re-evaluates on
// the theme-carrying attribute mutations of <html>/<body> (see `attrs` below)
// and on prefers-color-scheme changes. The popup's Theme setting can force one
// palette instead (setThemePreference), which short-circuits all of it.

export type Theme = "light" | "dark";
/** The popup's Theme setting: a forced palette, or "system" to keep the detection below. */
export type ThemePreference = Theme | "system";

const subscribers = new Set<(t: Theme) => void>();
let watching = false;
let currentTheme: Theme = "light";
let forced: Theme | null = null;

// The stored preference is user-syncable data, so anything but the two explicit
// palettes resolves to "system".
function forcedTheme(pref: ThemePreference): Theme | null {
  return pref === "light" || pref === "dark" ? pref : null;
}

export function setThemePreference(pref: ThemePreference): void {
  const next = forcedTheme(pref);
  if (next === forced) return;
  forced = next;
  if (watching) recheck();
}

// Extension pages (popup, auth) have no host site to blend with: their palette is the
// preference, resolved against the browser only when it says "system".
export function applyDocumentTheme(pref: ThemePreference): void {
  document.documentElement.dataset.theme = forcedTheme(pref) ?? systemTheme();
}

function systemTheme(): Theme {
  if (typeof window === "undefined" || !window.matchMedia) return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function detectTheme(): Theme {
  if (forced) return forced;
  if (typeof document === "undefined") return "light";

  // Only act if one wins outright.
  const colorScheme = getComputedStyle(document.documentElement).colorScheme;
  if (colorScheme) {
    const hasDark = /\bdark\b/.test(colorScheme);
    const hasLight = /\blight\b/.test(colorScheme);
    if (hasDark && !hasLight) return "dark";
    if (hasLight && !hasDark) return "light";
  }

  const fromBg = luminanceTheme(document.body) ?? luminanceTheme(document.documentElement);
  if (fromBg) return fromBg;

  return systemTheme();
}

function luminanceTheme(el: Element | null): Theme | null {
  if (!el) return null;
  const background = getComputedStyle(el).backgroundColor;
  // Only rgb()/rgba() is parsed. getComputedStyle serializes named and hex values
  // to rgb(), but oklch/oklab/lab/lch/color() keep their own space and fall
  // through to systemTheme.
  const rgbMatch = background.match(/^rgba?\(([^)]+)\)$/);
  if (!rgbMatch) return null;
  const raw = rgbMatch[1];
  if (!raw) return null;
  const parts = raw.split(",").map((part) => parseFloat(part.trim()));
  if (parts.length < 3) return null;
  const r = parts[0];
  const g = parts[1];
  const b = parts[2];
  const a = parts.length >= 4 ? parts[3] : 1;
  if (r === undefined || g === undefined || b === undefined || !Number.isFinite(r + g + b)) {
    return null;
  }
  if (a === 0) return null;
  // Rec. 601 luma - cheaper than sRGB linearization and accurate
  // enough for a binary light/dark classification.
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum < 0.5 ? "dark" : "light";
}

export function watchTheme(cb: (t: Theme) => void): () => void {
  subscribers.add(cb);
  if (!watching) startWatching();
  // Push current value immediately so the caller can stamp the
  // attribute on its host without an extra detect() call.
  cb(currentTheme);
  return () => {
    subscribers.delete(cb);
    // Last listener gone: drop the observers too. A MutationObserver on
    // <html>/<body> attributes fires on every class swap a site makes, and
    // nothing was listening for the result.
    if (subscribers.size === 0) stopWatching();
  };
}

export function getCurrentTheme(): Theme {
  if (!watching) currentTheme = detectTheme();
  return currentTheme;
}

function recheck(): void {
  const next = detectTheme();
  if (next === currentTheme) return;
  currentTheme = next;
  for (const cb of subscribers) cb(next);
}

// `detectTheme` reads computed styles off <html> and <body>, so every call flushes
// pending style. The observed attributes include `class` and `style`, which sites
// rewrite on those two elements while scrolling - one forced flush per mutation batch,
// for an answer that cannot change more than once a frame. Coalesce into one frame.
// setThemePreference stays synchronous: it is a user action, not a page mutation.
let scheduledRecheck = 0;

function scheduleRecheck(): void {
  if (scheduledRecheck) return;
  const run = (): void => {
    scheduledRecheck = 0;
    recheck();
  };
  // `window.setTimeout`, not the bare global: only the DOM overload returns a `number`, and
  // `scheduledRecheck` holds either that or a rAF handle. This branch is reached only in a
  // document without rAF, which is a window by definition.
  scheduledRecheck = typeof requestAnimationFrame === "function" ? requestAnimationFrame(run) : window.setTimeout(run, 0);
}

function cancelScheduledRecheck(): void {
  if (!scheduledRecheck) return;
  // Same predicate scheduleRecheck used, so the handle is cancelled by the API that made it.
  if (typeof requestAnimationFrame === "function") cancelAnimationFrame(scheduledRecheck);
  else window.clearTimeout(scheduledRecheck);
  scheduledRecheck = 0;
}

// Held so stopWatching can undo exactly what startWatching installed.
let themeObserver: MutationObserver | null = null;
let colorSchemeQuery: MediaQueryList | null = null;

function startWatching(): void {
  if (watching) return;
  watching = true;
  currentTheme = detectTheme();

  if (typeof MutationObserver !== "undefined") {
    const attrs = ["class", "style", "data-theme", "data-color-mode", "data-color-scheme", "color-scheme"];
    themeObserver = new MutationObserver(scheduleRecheck);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: attrs,
    });
    if (document.body) {
      themeObserver.observe(document.body, { attributes: true, attributeFilter: attrs });
    }
  }

  if (typeof window !== "undefined" && window.matchMedia) {
    colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");
    // addEventListener only: every shipped target (Chromium MV3, Firefox MV2
    // with strict_min_version 128, Safari) has had it since 2020 - no
    // addListener path.
    colorSchemeQuery.addEventListener("change", scheduleRecheck);
  }
}

function stopWatching(): void {
  if (!watching) return;
  watching = false;
  cancelScheduledRecheck();
  themeObserver?.disconnect();
  themeObserver = null;
  colorSchemeQuery?.removeEventListener("change", scheduleRecheck);
  colorSchemeQuery = null;
}
