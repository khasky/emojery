// SPDX-License-Identifier: GPL-3.0-or-later
//
// Types for css-shrink.mjs, which wxt.config.ts imports. The implementation itself is
// checked as JS (`// @ts-check` + `checkJs` in scripts/tsconfig.json); this only exists
// because the root tsconfig does not enable allowJs, and one shape is cheaper to keep in
// step than turning JS checking on for the whole project.

/** Comment-free, indentation-free stylesheet text. Removes bytes only - never rewrites a declaration. */
export declare function shrinkCss(css: string): string;
