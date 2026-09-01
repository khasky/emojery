// SPDX-License-Identifier: GPL-3.0-or-later
//
// Emojery CSS selectors shared by BOTH e2e routes. Dependency-free on
// purpose: the site-auth bridge suite runs under vitest and must not pull
// `@playwright/test` in through `lib/extension.ts` just to reach a selector.
//
// Playwright pierces the open shadow roots, so these reach inside
// `.khasky-emojery-host` / `.khasky-emojery-overlay-host`.

export const HOST_SELECTOR = ".khasky-emojery-host";
export const TRIGGER_SELECTOR = ".khasky-emojery-trigger, .khasky-emojery-counter";
export const GRID_ITEM_SELECTOR = ".khasky-emojery-grid-item";
export const SEARCH_INPUT_SELECTOR = ".khasky-emojery-search";
