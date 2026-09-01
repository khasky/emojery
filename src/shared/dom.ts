// SPDX-License-Identifier: GPL-3.0-or-later
//
// The names of Emojery's own injected DOM that cross a module boundary - what the
// adapters, the UI layer and the e2e probes all have to agree on. picker.css and the
// test/e2e selectors spell them out literally, so both must match.
//
// NOT every attribute we stamp: one written and read inside a single module stays next
// to its writer (mount-style.ts's sizing and filled marks, ring-spin.ts's animate mark,
// native-compact.ts's saved count, mount-registry.ts's wrapper spec, emoji-sprite.ts's
// sprite mode, themed-hosts.ts's data-theme). Add a name here only when a second
// module needs it.

// Prefix every injected class and attribute shares. Author-scoped so it can't
// collide with a host page's own names.
const NS = "khasky-emojery";

export const HOST_CLASS = `${NS}-host`;
export const OVERLAY_HOST_CLASS = `${NS}-overlay-host`;
export const TRIGGER_CLASS = `${NS}-trigger`;
export const COUNTER_CLASS = `${NS}-counter`;
// Decorative gradient-border element inside the trigger/counter (and their icon variants).
export const RING_CLASS = `${NS}-ring`;

export const MOUNT_ATTR = `data-${NS}-mounted`;
export const HIDDEN_ATTR = `data-${NS}-hidden`;
// On the host while the one-time coach-mark points at its trigger (ui/coach-mark.ts);
// picker.css keys the pulse ring on it.
export const COACH_ATTR = `data-${NS}-coach`;
// Which placement a mounted host currently uses ("primary" | "fallback"), set
// on the host so a re-scan can tell when the two placements need swapping.
export const PLACEMENT_ATTR = `data-${NS}-placement`;

// The trigger's form ("icon-column" on a reel/shorts rail, absent on a horizontal row):
// mount-style.ts stamps it, mount.ts reads it back to tell a moved host whether its form
// still matches, picker-hooks.ts reads it to open the popover sideways, and picker.css keys
// its `:host([...])` rules on it.
export const LAYOUT_ATTR = `data-${NS}-layout`;

// The host page's measured font size, stamped on a host (or on the portalled popover) for
// picker.css to clamp. The bounds live only in that stylesheet - never re-clamp here.
export const PAGE_FONT_VAR = `--${NS}-page-font`;

export const HOST_SELECTOR = `.${HOST_CLASS}`;
// Either of our injected roots: an inline trigger host or the overlay host.
export const OWN_NODES_SELECTOR = `.${HOST_CLASS}, .${OVERLAY_HOST_CLASS}`;
// A native control hidden for the "Hide original buttons" setting.
export const HIDDEN_SELECTOR = `[${HIDDEN_ATTR}="1"]`;
