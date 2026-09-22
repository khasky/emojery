// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the two accessibility specs share: the axe-core source they inject, the
// rule tags they scan for, how a violation is reported, and the WCAG
// text-spacing overrides. a11y.spec.ts scans through Playwright pages (Chromium);
// a11y-firefox.spec.ts scans the same pages through firefox-bridge.ts.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { AGREE_SELECTOR, CARD_SELECTOR, TAGLINE_SELECTOR } from "./selectors";

export const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");

export const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

export const COLOR_SCHEMES = ["light", "dark"] as const;
export const POPUP_TABS = ["Settings", "History", "Account", "Report"] as const;

export interface AxeViolation {
  id: string;
  impact: string | null;
  help: string;
  nodes: { target: string[] }[];
}

// One formatted line per violation so a red run names every offender at once.
export function formatViolations(label: string, violations: AxeViolation[]): string[] {
  return violations.map((v) => `${label}: [${v.impact}] ${v.id} (${v.help}) at ${v.nodes.map((n) => n.target.join(" ")).join("; ")}`);
}

// Text-spacing user style overrides. Elements MEANT to truncate (history
// URLs, hints with text-overflow) are exempt; the checked selectors are the
// always-visible reading surfaces that must never clip under these overrides.
export const TEXT_SPACING_CSS = `
  * {
    line-height: 1.5 !important;
    letter-spacing: 0.12em !important;
    word-spacing: 0.16em !important;
  }
  p, h1, h2, h3, li { margin-bottom: 2em !important; }
`;

// The reflow and text-spacing tables both specs walk. They live here because the
// two files are mutually exclusive by engine skip: a selector added to only one
// list is never checked on the other engine, and both runs stay green.

/** Narrowest width each page must survive without horizontal scrolling (WCAG 1.4.10).
 *  auth and onboarding are normal tabs, so the 320 CSS px breakpoint applies as-is;
 *  the popup is fixed-size browser chrome with a declared 360px floor (popup.css
 *  min-width). */
export const REFLOW_WIDTH_PX = { auth: 320, onboarding: 320, popup: 360 } as const;

/** The always-visible reading surfaces checked for clipping under TEXT_SPACING_CSS. */
export const TEXT_SPACING_SELECTORS = {
  auth: [`${CARD_SELECTOR} h1`, TAGLINE_SELECTOR, "label", `${AGREE_SELECTOR} span`, "button.primary"],
  onboarding: [`${CARD_SELECTOR} h1`, ".checklist .label"],
  popup: [".tab", ".row-label > span:first-child", ".brand-title span"],
} as const;

/** Serialized into the page by both specs, so keep it closure-free. */
export const hasHorizontalOverflowProbe = (): boolean => Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, document.body.scrollWidth - document.body.clientWidth) > 0;
