// SPDX-License-Identifier: GPL-3.0-or-later
import { type ComponentChild, Fragment } from "preact";
import { useState } from "preact/hooks";
import type { SupportedSite } from "../../shared/adapter";
import { t } from "../../shared/i18n";
import { DEFAULT_SITE_TOGGLES, resolveSiteHomeUrl, SITE_LABELS } from "../../shared/sites";
import type { Settings } from "../../shared/storage";
import { withExtensionUtm } from "../../shared/tracking-links";
import { EmojiSentimentEditor } from "./popup-emoji-sentiment";
import { brandIcon, IconRow, rowIcon, SearchField, useActiveTabUrl } from "./popup-shared";

// Site-specific resolution (Amazon's regional storefront vs. one global domain)
// lives in `shared/sites.ts`; the popup only supplies the runtime signals that
// module can't read itself.
function getTrackedSiteHomeUrl(site: SupportedSite, activeHost: string | null): string {
  const lang = (typeof navigator !== "undefined" && navigator.language) || "";
  return withExtensionUtm(resolveSiteHomeUrl(site, activeHost, lang), {
    campaign: "popup_per_site_links",
    content: site,
  });
}

const ICON_POWER: ComponentChild[] = [<path d="M12 3.5v7.5" />, <path d="M7.5 6.7a7 7 0 1 0 9 0" />];
const ICON_SWAP: ComponentChild[] = [<path d="M4 8.5h13m0 0l-3.2-3.2M17 8.5l-3.2 3.2" />, <path d="M20 15.5H7m0 0l3.2-3.2M7 15.5l3.2 3.2" />];
const ICON_SPARK: ComponentChild[] = [<path d="M12 4l1.7 4.8L18.5 10l-4.8 1.7L12 16.5l-1.7-4.8L5.5 10l4.8-1.2z" />];
const ICON_THUMB: ComponentChild[] = [<path d="M7 10.5v9M7 19.5h9.2a2 2 0 0 0 2-1.7l1-6a2 2 0 0 0-2-2.3h-4.7l.9-3.6a1.6 1.6 0 0 0-3-1.1L7 10.5H4.5v9z" />];
const ICON_GLOBE: ComponentChild[] = [<circle cx="12" cy="12" r="8.5" />, <path d="M3.5 12h17" />, <path d="M12 3.5c2.4 2.3 3.7 5.1 3.7 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.7-5.1-3.7-8.5S9.6 5.8 12 3.5z" />];
// Contrast dial: the filled half needs its own fill/stroke, since svgIcon paints stroke-only.
const ICON_THEME: ComponentChild[] = [<circle cx="12" cy="12" r="8.5" />, <path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none" />];
// Also the header's Debug toggle (main.tsx), so the control that reveals the panel and the
// one that opens it read as the same thing.
export const ICON_BUG: ComponentChild[] = [<path d="M9 7.5a3 3 0 0 1 6 0" />, <rect x="7.5" y="7.5" width="9" height="11" rx="4.5" />, <path d="M4 11h3.5M16.5 11H20M4 16h3.5M16.5 16H20M7 6l1.6 1.6M17 6l-1.6 1.6" />];
const THEME_CHOICES = ["system", "light", "dark"] as const;
const THEME_LABEL_KEYS = { system: "themeSystem", light: "themeLight", dark: "themeDark" } as const;

export const SettingsView = ({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => Promise<void> }) => {
  // Active tab host drives the per-site link target (on amazon.de the Amazon row links amazon.de).
  // Null on a non-http(s) URL (chrome://, about:) - the locale fallback in getTrackedSiteHomeUrl covers it.
  const activeTabUrl = useActiveTabUrl();
  const activeHost = activeTabUrl?.host ?? null;
  const [siteQuery, setSiteQuery] = useState("");

  // A site left off IS per-site control, so the section opens itself for it - derived,
  // not a useState initializer, because `settings` arrives after the first render.
  const [perSiteOpen, setPerSiteOpen] = useState(false);
  const perSiteOn = perSiteOpen || Object.values(settings.sites).some((on) => !on);
  const togglePerSite = (on: boolean) => {
    setPerSiteOpen(on);
    // Off means "every supported site": clear the exclusions, or the collapsed row
    // would claim on-everywhere while a site stays silently off.
    if (!on) void update({ sites: { ...DEFAULT_SITE_TOGGLES } });
  };

  const query = siteQuery.trim().toLowerCase();
  const sites = (Object.keys(SITE_LABELS) as SupportedSite[]).filter((site) => !query || SITE_LABELS[site].toLowerCase().includes(query));

  const generalRow = (icon: ComponentChild[], label: string, hint: string, checked: boolean, onToggle: (v: boolean) => void) => (
    <IconRow tag="label" icon={icon} label={label} hint={hint}>
      <input class="toggle" type="checkbox" checked={checked} onChange={(e: Event) => onToggle((e.currentTarget as HTMLInputElement).checked)} />
    </IconRow>
  );

  return (
    <Fragment>
      {generalRow(ICON_POWER, t("settingEnabled"), t("settingEnabledHint"), settings.enabled, (v) => update({ enabled: v }))}
      {generalRow(ICON_GLOBE, t("sectionPerSite"), t("sectionPerSiteHint"), perSiteOn, togglePerSite)}
      {perSiteOn ? (
        <Fragment>
          <SearchField wrapClass="settings-filter" inputClass="settings-filter-input" placeholder={t("filterSitesPlaceholder")} value={siteQuery} onInput={setSiteQuery} />
          {/* The per-site row is a <div> (not <label>) because it contains an <a> for
              the site name - a <label> would toggle the input on any link click. */}
          {sites.map((site) => (
            <div class="row" key={site}>
              {brandIcon(site)}
              {/* Anchor nested in a plain <span> so it keeps its intrinsic text width
                  (a direct flex child of .row-label would stretch the hit-area). */}
              <span class="row-label">
                <span>
                  <a href={getTrackedSiteHomeUrl(site, activeHost)} target="_blank" rel="noopener noreferrer">
                    {SITE_LABELS[site]}
                  </a>
                </span>
              </span>
              <input class="toggle" type="checkbox" aria-label={t("perSiteToggleAria", SITE_LABELS[site])} checked={settings.sites[site]} onChange={(e: Event) => update({ sites: { ...settings.sites, [site]: (e.currentTarget as HTMLInputElement).checked } })} />
            </div>
          ))}
        </Fragment>
      ) : null}
      {generalRow(ICON_THUMB, t("settingAutoTrigger"), t("settingAutoTriggerHint"), settings.autoTriggerNative, (v) => update({ autoTriggerNative: v }))}
      {settings.autoTriggerNative ? <EmojiSentimentEditor settings={settings} update={update} /> : null}
      {generalRow(ICON_SWAP, t("settingReplaceNative"), t("settingReplaceNativeHint"), settings.replaceNative, (v) => update({ replaceNative: v }))}
      {generalRow(ICON_SPARK, t("settingAnimations"), t("settingAnimationsHint"), settings.reactionAnimations, (v) => update({ reactionAnimations: v }))}
      <label class="row">
        {rowIcon(ICON_THEME)}
        <span class="row-label">
          <span>{t("settingTheme")}</span>
          <span class="row-hint">{t("settingThemeHint")}</span>
        </span>
        <select class="row-select" value={settings.theme} onChange={(e: Event) => update({ theme: (e.currentTarget as HTMLSelectElement).value as Settings["theme"] })}>
          {THEME_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {t(THEME_LABEL_KEYS[choice])}
            </option>
          ))}
        </select>
      </label>
      {/* Last row: it reveals a developer tab, so it stays below every setting a
          normal user came here for. */}
      {generalRow(ICON_BUG, t("settingDebug"), t("settingDebugHint"), settings.debugMode, (v) => update({ debugMode: v }))}
    </Fragment>
  );
};
