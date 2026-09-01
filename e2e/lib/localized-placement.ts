// SPDX-License-Identifier: GPL-3.0-or-later
//
// Does the trigger still land next to the site's own control when the site is
// rendered in another language? The adapters classify action rows by localized
// label stems, so this is the check that catches a stem that stopped matching -
// the failure mode a same-language run cannot see. The per-site label tables
// stay in site-injection.spec.ts.
import { expect, type Page } from "@playwright/test";
import { debugEvidence } from "./page-settle";
import { DEEP_QUERY_ALL_SRC, IS_VISIBLE_RECT_SRC, MOUNTED_KEY_OF_SRC, RECT_GEOMETRY_SRC } from "./probe-src";
import type { MountEvidence, Rect, SupportedSiteScenario } from "./site-evidence";

// Fallbacks for a scenario that pins neither distance itself: how far the
// trigger may sit from the localized native control and still count as "in the
// same action row". Wide on purpose - a row can carry several controls between
// the two - the assertion that matters is that they are in one row at all.
const DEFAULT_MAX_HORIZONTAL_DISTANCE_PX = 700;
const DEFAULT_MAX_VERTICAL_DISTANCE_PX = 160;

export interface I18nLocaleCase {
  locale: "ru" | "de" | "ja";
  query: string;
}

export interface LocalizedAdapterCheck {
  site: SupportedSiteScenario["site"];
  label: string;
  labelPatterns: Record<I18nLocaleCase["locale"], string[]>;
  maxHorizontalDistance?: number;
  maxVerticalDistance?: number;
}

interface LocalizedNativePlacementEvidence {
  site: string;
  locale: string;
  url: string;
  title: string;
  hostCount: number;
  visibleMatchingHostCount: number;
  visibleLocalizedNativeCount: number;
  placementOk: boolean;
  closestDistance: number | null;
  hostSamples: Array<{
    mountKey: string | null;
    text: string;
    rect: Rect;
  }>;
  nativeSamples: Array<{
    tag: string;
    label: string;
    rect: Rect;
    distance: number | null;
  }>;
}

export async function expectLocalizedNativePlacement(page: Page, site: SupportedSiteScenario, check: LocalizedAdapterCheck, locale: I18nLocaleCase["locale"], mountEvidence: MountEvidence): Promise<void> {
  expect(mountEvidence.visibleMatchingHostCount, debugEvidence(mountEvidence)).toBeGreaterThan(0);
  expect(mountEvidence.placementOk, debugEvidence(mountEvidence)).toBe(true);

  const evidence = await collectLocalizedNativePlacementEvidence(page, site, check, locale);
  expect(evidence.visibleLocalizedNativeCount, debugLocalizedPlacement(evidence)).toBeGreaterThan(0);
  expect(evidence.placementOk, debugLocalizedPlacement(evidence)).toBe(true);
}

async function collectLocalizedNativePlacementEvidence(page: Page, site: SupportedSiteScenario, check: LocalizedAdapterCheck, locale: I18nLocaleCase["locale"]): Promise<LocalizedNativePlacementEvidence> {
  const probeInput = JSON.stringify({
    siteName: site.site,
    localeName: locale,
    mountKeyPattern: site.mountKeyPattern,
    labelPatterns: check.labelPatterns[locale],
    maxX: check.maxHorizontalDistance ?? site.maxHorizontalDistance ?? DEFAULT_MAX_HORIZONTAL_DISTANCE_PX,
    maxY: check.maxVerticalDistance ?? site.maxVerticalDistance ?? DEFAULT_MAX_VERTICAL_DISTANCE_PX,
  });

  // A SOURCE-STRING evaluate body - see probe-src.ts for why, and for the two
  // rules when editing one (no `${...}`, every regex backslash doubled).
  return page.evaluate<LocalizedNativePlacementEvidence>(`(() => {
      const { siteName, localeName, mountKeyPattern, labelPatterns, maxX, maxY } = ${probeInput};
      // Patterns come from a suite fixture, never from input.
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const pattern = new RegExp(mountKeyPattern);
      // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
      const labelRegexes = labelPatterns.map((source) => new RegExp(source, "iu"));

      ${DEEP_QUERY_ALL_SRC}
      ${IS_VISIBLE_RECT_SRC}
      ${MOUNTED_KEY_OF_SRC}

      ${RECT_GEOMETRY_SRC}

      const labelOf = (el) => {
        const aria = el.getAttribute("aria-label");
        const title = el.getAttribute("title");
        const alt = el.getAttribute("alt");
        const value = el.getAttribute("value");
        const text = el.textContent;
        return (aria || title || alt || value || text || "").replace(/\\s+/g, " ").trim();
      };

      const isNativeControl = (el) => {
        if (el.closest(".khasky-emojery-host, .khasky-emojery-overlay-host")) return false;
        const tag = el.tagName.toLowerCase();
        if (tag === "button" || tag === "svg") return true;
        const role = el.getAttribute("role");
        if (role === "button" || role === "link") return true;
        if (el.hasAttribute("aria-label") || el.hasAttribute("title")) return true;
        return false;
      };

      const hosts = deepQueryAll(".khasky-emojery-host")
        .map((host) => ({
          el: host,
          mountKey: mountedKeyOf(host),
          rect: rectOf(host),
          text: (host.shadowRoot?.textContent ?? host.textContent ?? "").replace(/\\s+/g, " ").trim(),
        }))
        .filter((host) => host.mountKey && pattern.test(host.mountKey));
      const visibleHosts = hosts.filter((host) => isVisibleRect(host.rect));

      const nativeCandidates = deepQueryAll(["button", '[role="button"]', 'a[role="button"]', "svg[aria-label]", "[aria-label]", "[title]"].join(","))
        .map((el) => ({ el, label: labelOf(el), rect: rectOf(el) }))
        .filter((candidate) => isNativeControl(candidate.el) && candidate.label.length > 0 && isVisibleRect(candidate.rect) && labelRegexes.some((regex) => regex.test(candidate.label)));

      let closestDistance = null;
      let placementOk = false;
      const nativeSamples = nativeCandidates.slice(0, 12).map((candidate) => {
        let candidateDistance = null;
        for (const host of visibleHosts) {
          const d = distance(host.rect, candidate.rect);
          candidateDistance = candidateDistance === null ? d : Math.min(candidateDistance, d);
          closestDistance = closestDistance === null ? d : Math.min(closestDistance, d);
          if (near(host.rect, candidate.rect)) placementOk = true;
        }
        return {
          tag: candidate.el.tagName.toLowerCase(),
          label: candidate.label.slice(0, 160),
          rect: candidate.rect,
          distance: candidateDistance,
        };
      });

      return {
        site: siteName,
        locale: localeName,
        url: location.href,
        title: document.title,
        hostCount: hosts.length,
        visibleMatchingHostCount: visibleHosts.length,
        visibleLocalizedNativeCount: nativeCandidates.length,
        placementOk,
        closestDistance,
        hostSamples: visibleHosts.slice(0, 8).map((host) => ({
          mountKey: host.mountKey,
          text: host.text.slice(0, 120),
          rect: host.rect,
        })),
        nativeSamples,
      };
  })()`);
}

function debugLocalizedPlacement(evidence: LocalizedNativePlacementEvidence): string {
  return JSON.stringify(evidence, null, 2);
}
