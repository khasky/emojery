// SPDX-License-Identifier: GPL-3.0-or-later
/// <reference types="vite/client" />
// @types/chrome >=0.1 is no longer auto-included by tsc the way 0.0.x was, so
// pull its global `chrome` namespace in explicitly.
/// <reference types="chrome" />

declare module "*.css?raw" {
  const css: string;
  export default css;
}

// The authored text of a stylesheet the build ships shrunk (scripts/lib/shrink-raw-css.ts
// skips this query). Read by picker-css.browser.test.tsx only.
declare module "*.css?raw&authored" {
  const css: string;
  export default css;
}
