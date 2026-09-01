// SPDX-License-Identifier: GPL-3.0-or-later
//
// Canonical in-page probe helpers as JS *source strings*, composed into
// `page.evaluate` bodies by template interpolation - the same pattern as
// site-auth/probes.ts's DQ_SRC. One definition here, used by every probe in this
// folder: an evaluate callback is serialized, so it cannot close over an imported
// function - source strings are the only way to share one. A probe that must stay
// a TYPE-CHECKED callback takes the element it works on as an ElementHandle
// resolved by a source-string probe (see theme-contrast.spec.ts measureTrigger)
// rather than re-declaring the walk inline.
//
// Two rules for the bodies that interpolate them: no `${...}` inside the outer
// template (it would run at build time - concatenate instead), and every regex
// backslash doubled (`/\\s+/g` emits `/\s+/g`; a single one is dropped by the
// template literal, which biome's noUselessEscapeInString flags).
//
// NOTE: site-auth/probes.ts keeps its own DQ_SRC on purpose - its `dq` bundles
// that suite's own `triggerIn` helper into the same string, and the bridge suite
// runs under vitest, sharing only lib's leaf constants and config with this
// folder instead of its @playwright/test-bound probe helpers.

// Shadow-piercing deep query - `document.querySelector` does NOT cross the open
// shadow roots the trigger/picker live in.
export const DEEP_QUERY_ALL_SRC = `const deepQueryAll = (selector) => {
  const out = [];
  const seen = new Set();
  const visit = (root) => {
    let local = [];
    try {
      local = Array.from(root.querySelectorAll(selector));
    } catch {
      local = [];
    }
    for (const el of local) {
      if (!seen.has(el)) {
        seen.add(el);
        out.push(el);
      }
    }
    let all = [];
    try {
      all = Array.from(root.querySelectorAll("*"));
    } catch {
      all = [];
    }
    for (const el of all) {
      if (el.shadowRoot) visit(el.shadowRoot);
    }
  };
  visit(document);
  return out;
};`;

// Deepest focused element across the open shadow roots: `document.activeElement`
// stops at the shadow HOST, so a focused trigger or grid option inside it reads
// as the host itself.
export const ACTIVE_IN_ROOT_SRC = `const activeInRoot = (root) => {
  const active = root.activeElement;
  if (!active) return null;
  const shadow = active.shadowRoot;
  return shadow ? (activeInRoot(shadow) ?? active) : active;
};`;

// Rect geometry for the placement probes (page-settle's evidence probe and
// localized-placement's). `near` reads `maxX`/`maxY` from the probe's own
// scenario input, so interpolate this only AFTER those are in scope.
export const RECT_GEOMETRY_SRC = `const rectOf = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height, top: r.top, right: r.right, bottom: r.bottom, left: r.left };
};

const center = (rect) => ({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });

const distance = (a, b) => {
  const ca = center(a);
  const cb = center(b);
  return Math.round(Math.hypot(ca.x - cb.x, ca.y - cb.y));
};

const near = (a, b) => {
  const ca = center(a);
  const cb = center(b);
  const verticalOverlap = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return (Math.abs(ca.y - cb.y) <= maxY || verticalOverlap > 0) && Math.abs(ca.x - cb.x) <= maxX;
};`;

// The page's reaction trigger: the first VISIBLE host's trigger (or counter)
// button, together with the host it belongs to. For the single-target pages the
// authed specs use - a page with several targets needs a key-scoped read
// instead. Interpolate AFTER DEEP_QUERY_ALL_SRC. Visible = non-zero WIDTH, the
// check both readers built on this have always used.
export const FIRST_VISIBLE_TRIGGER_SRC = `const firstVisibleTrigger = () => {
  for (const host of deepQueryAll(".khasky-emojery-host")) {
    if (host.getBoundingClientRect().width <= 0) continue;
    const trigger = host.shadowRoot?.querySelector(".khasky-emojery-trigger, .khasky-emojery-counter");
    if (trigger) return { host, trigger };
  }
  return null;
};`;

// A rect that has a size and intersects the viewport.
export const IS_VISIBLE_RECT_SRC = `const isVisibleRect = (rect) => rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;`;

// Target key for a host: the `[data-khasky-emojery-mounted]` anchor can be an
// ancestor, a sibling of the host (or its wrapper), or the parent - the host is
// sometimes placed in a different DOM node than its keyed anchor.
export const MOUNTED_KEY_OF_SRC = `const mountedKeyOf = (host) => {
  const direct = host.closest("[data-khasky-emojery-mounted]");
  if (direct) return direct.getAttribute("data-khasky-emojery-mounted");

  const candidates = [host];
  if (host.parentElement && !host.parentElement.classList.contains("khasky-emojery-overlay-host")) {
    candidates.push(host.parentElement);
  }

  for (const node of candidates) {
    const previous = node.previousElementSibling;
    const next = node.nextElementSibling;
    if (previous?.hasAttribute("data-khasky-emojery-mounted")) {
      return previous.getAttribute("data-khasky-emojery-mounted");
    }
    if (next?.hasAttribute("data-khasky-emojery-mounted")) {
      return next.getAttribute("data-khasky-emojery-mounted");
    }
    if (node.parentElement?.hasAttribute("data-khasky-emojery-mounted")) {
      return node.parentElement.getAttribute("data-khasky-emojery-mounted");
    }
  }

  return null;
};`;
