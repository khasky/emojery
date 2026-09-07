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

// The extension's OWN pages (popup, auth, onboarding) name their DOM in
// src/shared/page-dom.ts; re-exported here so a spec reaches every selector
// through one module, and a rename breaks `pnpm compile:e2e` rather than
// silently matching nothing.
export {
  ACCOUNT_LIST_SELECTOR,
  BUILD_INFO_SELECTOR,
  CARD_SELECTOR,
  CODE_INPUT_SELECTOR,
  DATA_FILE_SELECTOR,
  DATA_STATUS_SELECTOR,
  DEBUG_TAB_SELECTOR,
  EMAIL_INPUT_SELECTOR,
  EMPTY_NOTE_SELECTOR,
  HISTORY_DAY_SELECTOR,
  HISTORY_EMOJI_SELECTOR,
  HISTORY_LINK_SELECTOR,
  HISTORY_MORE_SELECTOR,
  HISTORY_NOMATCH_SELECTOR,
  HISTORY_ROW_SELECTOR,
  HISTORY_SEARCH_INPUT_SELECTOR,
  IMPORT_CONFIRM_COUNT_SELECTOR,
  IMPORT_CONFIRM_SELECTOR,
  NOTICE_SELECTOR,
  POPUP_SELECTOR,
  ROW_SELECT_SELECTOR,
  TAB_PANEL_SELECTOR,
  TAGLINE_SELECTOR,
} from "../../src/shared/page-dom";
