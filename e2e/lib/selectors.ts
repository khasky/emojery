// SPDX-License-Identifier: GPL-3.0-or-later
//
// The extension's injected DOM names, for BOTH e2e routes. Re-exported from the
// extension's own `src/shared/dom.ts` rather than spelled out again: a renamed class
// then breaks `pnpm compile:e2e` instead of quietly matching nothing on a live page.
// Dependency-free on purpose (that module is plain string constants) - the site-auth
// bridge suite runs under vitest and must not pull `@playwright/test` in through
// `lib/extension.ts` just to reach a selector.
//
// Playwright pierces the open shadow roots, so these reach inside
// `.khasky-emojery-host` / `.khasky-emojery-overlay-host`.

import { COUNTER_CLASS, TRIGGER_CLASS } from "../../src/shared/dom";

export {
  BREAKDOWN_ROW_CLASS,
  BREAKDOWN_ROW_SELECTOR,
  CLICK_FLOAT_CLASS,
  COACH_TIP_CLASS,
  COUNTER_CLASS,
  EMOJI_CLASS,
  GATE_CLASS,
  GATE_SIGNIN_CLASS,
  GLYPH_H_VAR,
  GRID_ITEM_CLASS,
  GRID_ITEM_SELECTOR,
  HIDDEN_ATTR,
  HIDDEN_SELECTOR,
  HOST_CLASS,
  HOST_SELECTOR,
  INTRO_PARTICLE_CLASS,
  MOUNT_ATTR,
  MOUNTED_SELECTOR,
  OVERLAY_HOST_CLASS,
  OVERLAY_HOST_SELECTOR,
  OWN_NODES_SELECTOR,
  POPOVER_CLASS,
  SEARCH_SELECTOR as SEARCH_INPUT_SELECTOR,
  SITE_FG_VAR,
  TRIGGER_CLASS,
  TRIGGER_ICON_CLASS,
  TRIGGER_SELECTOR,
} from "../../src/shared/dom";

// Element-scoped form of TRIGGER_SELECTOR, for probes that walk a host's shadow root
// and want the button itself rather than any node carrying the class.
export const TRIGGER_BUTTON_SELECTOR = `button.${TRIGGER_CLASS}, button.${COUNTER_CLASS}`;
