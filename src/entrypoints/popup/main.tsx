// SPDX-License-Identifier: GPL-3.0-or-later
import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { effectiveAnalyticsConsent } from "../../shared/data-consent";
import { isOwnHomepage } from "../../shared/homepage";
import { t } from "../../shared/i18n";
import { bootstrapPage } from "../../shared/page-bootstrap";
import { DEFAULT_SETTINGS, getSettings, mergeSettings, type Settings, setSettings } from "../../shared/storage";
import { applyDocumentTheme } from "../../shared/theme";
import { applyEmojiSpriteHost } from "../../ui/emoji-sprite";
import { AccountView } from "./popup-account";
import { HistoryView } from "./popup-history";
import { QueueView } from "./popup-queue";
import { ReportView } from "./popup-report";
import { ICON_BUG, SettingsView } from "./popup-settings";
import { BUILD_VERSION, svgIcon, useActiveTabUrl } from "./popup-shared";
import { nextViewForKey, rememberView, storedView, TAB_VIEWS, VIEW_LABEL_KEYS, type View } from "./popup-view-state";

// The stored Theme setting lands later, from the effect in App.
bootstrapPage(t("popupTitle"));

// `__EM_BUILD_TIME__` is injected at build time by wxt.config.ts.
declare const __EM_BUILD_TIME__: string;
const BUILD_TIME = typeof __EM_BUILD_TIME__ !== "undefined" ? __EM_BUILD_TIME__ : "";

function App() {
  const [view, setViewState] = useState<View>(storedView);
  const [settings, setLocal] = useState<Settings>(DEFAULT_SETTINGS);
  // Everything the user changed before the stored settings arrived. The popup opens on
  // DEFAULT_SETTINGS and hydrates one storage read later, so a toggle flipped inside that
  // window would be overwritten by the load; the loaded values go UNDER this patch instead.
  const preHydrationPatch = useRef<Partial<Settings>>({});
  const activeTabUrl = useActiveTabUrl();
  const onHomepage = isOwnHomepage(activeTabUrl?.href);

  const setView = (next: View) => {
    setViewState(next);
    rememberView(next);
  };

  useEffect(() => {
    void getSettings().then(async (loaded) => {
      const revoked = loaded.analyticsConsent !== false && !(await effectiveAnalyticsConsent(true));
      const hydrated = revoked ? { ...loaded, analyticsConsent: false } : loaded;
      setLocal(mergeSettings(hydrated, preHydrationPatch.current));
      preHydrationPatch.current = {};
      if (revoked) await setSettings({ analyticsConsent: false });
    });
  }, []);

  useEffect(() => {
    applyDocumentTheme(settings.theme);
  }, [settings.theme]);

  const update = async (patch: Partial<Settings>) => {
    // Functional, not `{ ...settings, ...patch }`: two toggles inside one render batch
    // would both read the same captured `settings` and the second would revert the first
    // on screen, while storage - which only ever receives the patch - kept both.
    setLocal((prev) => mergeSettings(prev, patch));
    // Accumulated as a PATCH (touched keys only), so hydration overlays exactly what the
    // user changed. A plain spread is right for `sites` too: every caller builds that
    // field as a whole record, so a later one legitimately replaces an earlier one.
    preHydrationPatch.current = { ...preHydrationPatch.current, ...patch };
    await setSettings(patch);
  };

  // Rendered from TAB_VIEWS, not from a second hand-ordered list: the arrow walk in
  // nextViewForKey steps through the same array, so a tab bar in any other order would
  // move the selection somewhere other than the neighbouring button.
  const tabDefs = TAB_VIEWS.map((id) => ({ id, label: t(VIEW_LABEL_KEYS[id]) }));
  // Debug is remembered like any other view but lives outside the strip, so it falls back
  // for THIS render only when it is switched off - leaving the stored value alone means
  // turning Debug back on returns to it.
  const shown: View = view !== "debug" || settings.debugMode ? view : "settings";
  // With Debug open no tab is selected, so the roving tabindex would leave the strip out
  // of the Tab sequence entirely; anchor it (and the arrow walk) on the first tab instead.
  const tabAnchor: View = shown === "debug" ? "settings" : shown;
  const debugToggleClass = ["debug-toggle", shown === "debug" ? "debug-toggle-active" : "", settings.debugMode ? "" : "debug-toggle-off"].filter(Boolean).join(" ");

  // Arrow/Home/End move focus between tabs and activate them (roving tabindex lives on TabBtn).
  const onTabKeyDown = (e: KeyboardEvent) => {
    const next = nextViewForKey(e.key, tabAnchor);
    if (!next) return;
    e.preventDefault();
    setView(next);
    document.getElementById(`em-tab-${next}`)?.focus();
  };

  return (
    <div class="popup">
      <header class="popup-header">
        <div class="brand-row">
          <h1 class="brand-title">
            <img class="brand-logo" src={onHomepage ? "/icons/icon-home-32.png" : "/icons/icon-32.png"} alt="" aria-hidden="true" />
            <span>{t("popupHeading")}</span>
          </h1>
          <BuildInfo showStamp={settings.debugMode} />
          {/* Debug rides in the header rather than as a fifth tab - popup-view-state.ts's
              TAB_VIEWS says why; the layout contract lives with .debug-toggle-off in popup.css. */}
          <button id="em-tab-debug" class={debugToggleClass} type="button" aria-pressed={shown === "debug" ? "true" : "false"} aria-controls="em-tabpanel" aria-label={t("settingDebug")} title={t("settingDebug")} onClick={() => setView(shown === "debug" ? "settings" : "debug")}>
            {svgIcon(ICON_BUG, "debug-toggle-icon")}
          </button>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the WAI-ARIA tabs pattern puts role="tablist" on the tab container, and <nav> is the right landmark for it */}
        <nav class="tabs" role="tablist" aria-label={t("popupHeading")} onKeyDown={onTabKeyDown}>
          {tabDefs.map((tb) => (
            <TabBtn key={tb.id} id={tb.id} active={shown === tb.id} anchor={tabAnchor === tb.id} onClick={() => setView(tb.id)} label={tb.label} />
          ))}
        </nav>
      </header>
      {/* The panel is a deliberate Tab stop per the WAI-ARIA tabs pattern - it scrolls, so
          keyboard users must reach it. Debug is opened by the header button rather than a
          tab, so for it the panel drops to a plain region: calling it a tabpanel while no
          tab is selected would be a lie. */}
      <main class="tab-panel" id="em-tabpanel" role={shown === "debug" ? "region" : "tabpanel"} aria-labelledby={`em-tab-${shown}`} tabIndex={0}>
        {shown === "settings" && <SettingsView settings={settings} update={update} />}
        {shown === "history" && <HistoryView />}
        {shown === "account" && <AccountView settings={settings} update={update} />}
        {shown === "report" && <ReportView />}
        {shown === "debug" && <QueueView />}
      </main>
    </div>
  );
}

const TabBtn = ({ id, active, anchor, onClick, label }: { id: View; active: boolean; anchor: boolean; onClick: () => void; label: string }) => (
  <button
    id={`em-tab-${id}`}
    role="tab"
    aria-selected={active ? "true" : "false"}
    aria-controls="em-tabpanel"
    // Roving tabindex: exactly one tab is in the Tab sequence (WAI-ARIA tabs pattern) - the
    // selected one, or the first when the Debug panel is what's open.
    tabIndex={anchor ? 0 : -1}
    class={active ? "tab tab-active" : "tab"}
    onClick={onClick}
    type="button"
  >
    {label}
  </button>
);

// Production ships a month-only stamp (reproducible builds); staging a full UTC instant, rendered in local time.
const formatBuildStamp = (iso: string): string => {
  if (!iso.includes("T")) return iso;
  const builtAt = new Date(iso);
  if (Number.isNaN(builtAt.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${builtAt.getFullYear()}-${pad(builtAt.getMonth() + 1)}-${pad(builtAt.getDate())} ${pad(builtAt.getHours())}:${pad(builtAt.getMinutes())}`;
};

// The build stamp is a debugging detail, so it rides with Debug mode; the version always shows.
const BuildInfo = ({ showStamp }: { showStamp: boolean }) => {
  if (!BUILD_VERSION) return null;
  const stamp = showStamp && BUILD_TIME ? formatBuildStamp(BUILD_TIME) : "";
  return (
    <div class="build-info" title={stamp ? `v${BUILD_VERSION} · ${BUILD_TIME}` : `v${BUILD_VERSION}`}>
      <span class="build-version">{`v${BUILD_VERSION}`}</span>
      {stamp ? <span class="build-stamp">{` · ${stamp}`}</span> : null}
    </div>
  );
};

const root = document.getElementById("app");
if (root) {
  // No shadow host on a normal extension page, so the sprite-mode flag and geometry vars hang
  // off #app; the chrome-extension:// sheet always loads here (no page CSP), with the OS-font
  // glyph as the graceful fallback.
  applyEmojiSpriteHost(root);
  render(<App />, root);
}
