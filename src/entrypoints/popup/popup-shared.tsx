// SPDX-License-Identifier: GPL-3.0-or-later
import { type ComponentChild, type ComponentChildren, Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { SupportedSite } from "../../shared/adapter";
import { t } from "../../shared/i18n";
import { queryActiveTab, sendRuntimeMessage } from "../../shared/webext";
import { SITE_BRAND } from "../../ui/brand-icons";

export const BUILD_VERSION = typeof chrome !== "undefined" ? (chrome.runtime.getManifest().version ?? "") : "";

// The unauthed empty state shared by the History, Account and Report tabs.
export const SignInPrompt = ({ message }: { message: string }) => (
  <section class="signin-prompt">
    <p class="signin-prompt-msg">{message}</p>
    <button
      class="primary"
      type="button"
      onClick={() => {
        // Swallowed: this prompt has no error surface - a failed open (background
        // unreachable) leaves the popup unchanged and the button ready to retry.
        void sendRuntimeMessage({ type: "auth:openTab" }).catch(() => {});
      }}
    >
      {t("signInBtn")}
    </button>
  </section>
);

// Each icon is an array of <path>/<circle> children (multi-stroke glyphs need more
// than one), rendered stroke-only; the colour follows the icon class set in popup.css.
export const svgIcon = (children: ComponentChild[], cls: string) => (
  <svg viewBox="0 0 24 24" class={cls} aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    {children}
  </svg>
);
const ICON_SEARCH: ComponentChild[] = [<circle cx="10.5" cy="10.5" r="6.5" />, <path d="M20 20l-4.7-4.7" />];
export const rowIcon = (children: ComponentChild[], danger = false) => svgIcon(children, danger ? "row-icon row-icon-danger" : "row-icon");

// Shared list-row shell for Settings and Account: icon, a label + hint stack, then the row's own
// control as children. `<label>` where that control is the row's checkbox (so the whole row toggles
// it), `<div>` where the row carries its own button instead.
export const IconRow = ({ icon, danger, label, hint, hintTitle, rowClass = "row", tag = "div", children }: { icon: ComponentChild[]; danger?: boolean; label: string; hint: string; hintTitle?: string | undefined; rowClass?: string; tag?: "div" | "label"; children?: ComponentChildren }) => {
  const body = (
    <Fragment>
      {rowIcon(icon, danger)}
      <span class="row-label">
        <span>{label}</span>
        <span class="row-hint" title={hintTitle}>
          {hint}
        </span>
      </span>
      {children}
    </Fragment>
  );
  // biome-ignore lint/a11y/noLabelWithoutControl: the associated control arrives as children - every `tag="label"` call site wraps its own checkbox
  return tag === "label" ? <label class={rowClass}>{body}</label> : <div class={rowClass}>{body}</div>;
};

// The popup's three search boxes (history, site filter, sentiment grid) share one shell:
// wrapper + glyph + a type="search" input whose placeholder doubles as its accessible name
// (`ariaLabel` overrides that where the two texts differ). Only two class pairs cover the three
// call sites - the sentiment grid reuses the site filter's - and the classes stay per-call-site
// props because e2e pins `.history-search-input`.
export const SearchField = ({ wrapClass, inputClass, placeholder, ariaLabel, value, onInput }: { wrapClass: string; inputClass: string; placeholder: string; ariaLabel?: string; value: string; onInput: (value: string) => void }) => (
  <div class={wrapClass}>
    {svgIcon(ICON_SEARCH, "field-search-icon")}
    <input type="search" class={inputClass} placeholder={placeholder} aria-label={ariaLabel ?? placeholder} value={value} onInput={(e: Event) => onInput((e.currentTarget as HTMLInputElement).value)} />
  </div>
);

// Focus a ref once `active` turns true. Every call site is a transient panel whose
// appearance unmounts the control that held focus, so without this the browser drops
// focus to <body> (WCAG 2.4.3).
export const useAutoFocus = (ref: { current: HTMLElement | null }, active = true): void => {
  useEffect(() => {
    if (active) ref.current?.focus();
  }, [active]);
};

// The active tab's parsed URL: `undefined` while the query is in flight, `null` once it
// settled on nothing usable (no tab, no readable URL, or a URL that won't parse - chrome://,
// about:). Callers that only need a usable page can collapse both with `?.`.
export const useActiveTabUrl = (): URL | null | undefined => {
  const [url, setUrl] = useState<URL | null | undefined>(undefined);
  useEffect(() => {
    void queryActiveTab()
      .then((tab) => setUrl(parseTabUrl(tab?.url)))
      .catch(() => setUrl(null));
  }, []);
  return url;
};

function parseTabUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

// A supported site's real vendor logo (see ui/brand-icons.ts). Filled, not
// stroked; brand-coloured, or theme text colour for the monochrome marks.
export const brandIcon = (site: SupportedSite) => {
  const brand = SITE_BRAND[site];
  return (
    <svg viewBox="0 0 24 24" class="site-icon" aria-hidden="true" fill={brand.color}>
      <path d={brand.path} />
    </svg>
  );
};

export { shortenUrl } from "./shorten-url";
