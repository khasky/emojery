// SPDX-License-Identifier: GPL-3.0-or-later
//
// Global Vitest setup: reset the shared jsdom surfaces after every test so
// DOM-building tests can't leak into each other - body AND head (style
// injections), localStorage, and any stubbed global (chrome/fetch/etc. via
// vi.stubGlobal). Suites that need a stubbed global re-install it per test.
// Deliberately imports NOTHING from src/ beyond types: a module pulled in here is
// instantiated before a test file's `vi.mock` factories are hoisted, so its own
// imports bind to the REAL modules and that instance is what the test then gets.
import { afterEach, vi } from "vitest";

afterEach(() => {
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  localStorage.clear();
  vi.unstubAllGlobals();
});
