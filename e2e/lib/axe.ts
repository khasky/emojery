// SPDX-License-Identifier: GPL-3.0-or-later
//
// What the two accessibility specs share: the axe-core source they inject, the
// rule tags they scan for, how a violation is reported, and the WCAG 1.4.12
// text-spacing overrides. a11y.spec.ts scans through Playwright pages (Chromium);
// a11y-firefox.spec.ts scans the same pages through firefox-bridge.ts.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

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

// WCAG 1.4.12 user style overrides. Elements that truncate BY DESIGN (history
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
