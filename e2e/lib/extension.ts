// SPDX-License-Identifier: GPL-3.0-or-later
//
// Barrel for the AUTONOMOUS e2e specs, kept for import stability - the
// specs and lib modules already import from `lib/extension`. Same reasoning as
// src/shared/storage.ts: the name is the stable one, the modules behind it are
// where the work lives. Import the specific module in new code - each module's
// own header says what it owns, and the export list below is the actual map.
// The live-site machinery the big suites share is deliberately not re-exported.

export { EXTENSION_ROOT, enMessage, extensionPageUrl, localeMessage } from "./auth-signin";
export * from "./browser-session";
export * from "./extension-pages";
export { extensionLaunchArgs, realisticClientEnabled } from "./launch-args";
export * from "./popup-settings";
export * from "./reaction-surface";
export * from "./test-config";
