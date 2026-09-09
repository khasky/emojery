// SPDX-License-Identifier: GPL-3.0-or-later
//
// The names of Emojery's own injected DOM - what the adapters, the UI layer, the unit
// tests and the e2e probes all have to agree on. picker.css, animations.css and the
// e2e selector strings spell them out literally, so every name here must match those.
//
// NOT every name we stamp: one written and read inside a single module stays next to its
// writer, exported from there for that module's own test rather than copied - mount-style.ts's
// sizing/filled marks, ring-spin.ts's animate mark, native-compact.ts's saved count,
// mount-registry.ts's wrapper spec, emoji-sprite.ts's sprite-mode attr, themed-hosts.ts's
// data-theme, picker.tsx's measured head height and category count. Add a name here only
// when a second module needs it.

// Prefix every injected class and attribute shares. Author-scoped so it can't
// collide with a host page's own names.
const NS = "khasky-emojery";

// --- Roots and mount markers ---

export const HOST_CLASS = `${NS}-host`;
export const OVERLAY_HOST_CLASS = `${NS}-overlay-host`;

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

// --- The trigger surface (picker-parts.tsx) ---

export const TRIGGER_CLASS = `${NS}-trigger`;
export const COUNTER_CLASS = `${NS}-counter`;
// Decorative gradient-border element inside the trigger/counter (and their icon variants).
export const RING_CLASS = `${NS}-ring`;
export const TRIGGER_ICON_CLASS = `${NS}-trigger-icon`;
export const COUNTER_EMOJIS_CLASS = `${NS}-counter-emojis`;
export const COUNTER_TOTAL_CLASS = `${NS}-counter-total`;

// --- The popover shell (picker.tsx) ---

export const PICKER_ROOT_CLASS = `${NS}-root`;
export const POPOVER_CLASS = `${NS}-popover`;
export const POPOVER_SCROLL_CLASS = `${NS}-popover-scroll`;
// The scroller when the popover opens upwards: the column reverses so the head sits at the bottom.
export const POPOVER_SCROLL_REVERSED_CLASS = `${POPOVER_SCROLL_CLASS}--reversed`;
export const POPOVER_DIVIDER_CLASS = `${NS}-popover-divider`;
export const STICKY_HEAD_CLASS = `${NS}-sticky-head`;
export const STICKY_HEAD_BOTTOM_CLASS = `${STICKY_HEAD_CLASS}--bottom`;
export const SEARCH_ROW_CLASS = `${NS}-search-row`;
export const SEARCH_ICON_CLASS = `${NS}-search-icon`;
export const SEARCH_CLASS = `${NS}-search`;
export const SR_ONLY_CLASS = `${NS}-sr-only`;
export const EMPTY_CLASS = `${NS}-empty`;

// --- The emoji grid (picker.tsx / picker-parts.tsx) ---

export const GRID_CLASS = `${NS}-grid`;
export const GRID_ITEM_CLASS = `${NS}-grid-item`;
export const SECTION_HEAD_CLASS = `${NS}-section-h`;
// The head of a section that also carries an action (Recently used's Clear).
export const SECTION_HEAD_ROW_CLASS = `${SECTION_HEAD_CLASS}--row`;
export const SECTION_CLEAR_CLASS = `${NS}-section-clear`;
// Index into CATEGORIES, stamped on each category section so the scroll-spy
// (picker-hooks.ts) and the category bar can address it.
export const CATEGORY_ATTR = `data-${NS}-cat`;

// --- Per-reaction totals above the grid (picker-parts.tsx) ---

export const BREAKDOWN_LIST_CLASS = `${NS}-breakdown-list`;
export const BREAKDOWN_ROW_CLASS = `${NS}-breakdown-row`;
export const BREAKDOWN_LABEL_CLASS = `${NS}-breakdown-label`;
export const BREAKDOWN_COUNT_CLASS = `${NS}-breakdown-count`;
export const BREAKDOWN_MORE_CLASS = `${NS}-breakdown-more`;

// --- Category shortcuts under the search box (picker-parts.tsx) ---

export const CAT_BAR_CLASS = `${NS}-cat-bar`;
export const CAT_BTN_CLASS = `${NS}-cat-btn`;
export const CAT_ICON_CLASS = `${NS}-cat-icon`;
export const CAT_UNDERLINE_CLASS = `${NS}-cat-underline`;

// --- The sign-in gate that replaces the palette for a held pick (picker.tsx) ---

export const GATE_CLASS = `${NS}-gate`;
export const GATE_EMOJI_CLASS = `${NS}-gate-emoji`;
export const GATE_TITLE_CLASS = `${NS}-gate-title`;
export const GATE_BODY_CLASS = `${NS}-gate-body`;
export const GATE_BTN_CLASS = `${NS}-gate-btn`;
export const GATE_SIGNIN_CLASS = `${NS}-gate-signin`;
export const GATE_CANCEL_CLASS = `${NS}-gate-cancel`;

// --- One rendered glyph (emoji-img.tsx and its imperative twin in emoji-sprite.ts) ---

export const EMOJI_CLASS = `${NS}-emoji`;
export const EMOJI_IMG_CLASS = `${NS}-emoji-img`;
// The glyph character stays in the DOM behind the sprite <img> so a11y, copy/paste
// and `textContent` selectors keep working.
export const EMOJI_CHAR_CLASS = `${NS}-emoji-char`;
// The sheet cell to crop, per glyph; the sheet's own dimensions, once per host.
export const SPRITE_COL_VAR = `--${NS}-col`;
export const SPRITE_ROW_VAR = `--${NS}-row`;
export const SPRITE_COLS_VAR = `--${NS}-sprite-cols`;
export const SPRITE_ROWS_VAR = `--${NS}-sprite-rows`;

// --- The one-time coach mark (coach-mark.ts) ---

export const COACH_TIP_CLASS = `${NS}-coach-tip`;
export const COACH_CLOSE_CLASS = `${NS}-coach-close`;
export const COACH_TITLE_CLASS = `${NS}-coach-title`;
export const COACH_BODY_CLASS = `${NS}-coach-body`;

// --- Reaction animations, appended to the page (animations.ts) ---

// The fixed overlay div the keyframes and particle rules render into, and the <style>
// that carries them. The id doubles as the sprite scope and as animations.css's
// `#khasky-emojery-reaction-animations` selector.
export const ANIMATION_LAYER_ID = `${NS}-reaction-animations`;
export const ANIMATION_STYLE_ID = `${ANIMATION_LAYER_ID}-style`;
export const CLICK_FLOAT_CLASS = `${NS}-reaction-click-float`;
export const INTRO_PARTICLE_CLASS = `${NS}-reaction-intro-particle`;
// Carried by the host only while the drop-in plays; mount-style.ts reads it to skip
// its flank probe (detaching the host would restart the animation). Styled in
// animations.css, which spells the class and its 360ms duration out literally.
export const BUTTON_DROP_CLASS = `${NS}-button-drop`;
export const BUTTON_DUST_CLASS = `${NS}-button-dust`;

// --- What mount-style.ts measures off the host page and stamps on the host ---
//
// The trigger/counter read them from picker.css via `var(--khasky-emojery-*, fallback)`;
// the e2e theme and glyph specs read them back to check the trigger tracks the page.

export const SITE_FG_VAR = `--${NS}-site-fg`;
export const SITE_BG_VAR = `--${NS}-site-bg`;
export const SITE_RADIUS_VAR = `--${NS}-site-radius`;
export const SITE_PAD_X_VAR = `--${NS}-site-pad-x`;
// The native row's box height (a min-height for filled row pills and icon-column triggers)
// and the visible height of its glyph.
export const ROW_H_VAR = `--${NS}-row-h`;
export const GLYPH_H_VAR = `--${NS}-glyph-h`;
// Square side for an icon-column trigger, when the rail publishes one.
export const ICON_SIZE_VAR = `--${NS}-icon-size`;

// The host page's measured font size, stamped on a host (or on the portalled popover) for
// picker.css to clamp. The bounds live only in that stylesheet - never re-clamp here.
export const PAGE_FONT_VAR = `--${NS}-page-font`;

// --- Selectors composed from the names above ---

export const HOST_SELECTOR = `.${HOST_CLASS}`;
export const OVERLAY_HOST_SELECTOR = `.${OVERLAY_HOST_CLASS}`;
// Either of our injected roots: an inline trigger host or the overlay host.
export const OWN_NODES_SELECTOR = `${HOST_SELECTOR}, ${OVERLAY_HOST_SELECTOR}`;
// A native control hidden for the "Hide original buttons" setting.
export const HIDDEN_SELECTOR = `[${HIDDEN_ATTR}="1"]`;
// The anchor carrying a mounted host's target key.
export const MOUNTED_SELECTOR = `[${MOUNT_ATTR}]`;
// Either form of the trigger: the compact icon button, or the counter it becomes.
export const TRIGGER_SELECTOR = `.${TRIGGER_CLASS}, .${COUNTER_CLASS}`;
export const GRID_ITEM_SELECTOR = `.${GRID_ITEM_CLASS}`;
export const SEARCH_SELECTOR = `.${SEARCH_CLASS}`;
export const BREAKDOWN_ROW_SELECTOR = `.${BREAKDOWN_ROW_CLASS}`;
