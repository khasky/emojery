// SPDX-License-Identifier: GPL-3.0-or-later
//
// Single source of truth for "which sites does the extension support?" -
// consumed by wxt.config.ts (manifest host_permissions + match patterns), the
// adapters' `matches(host)`, the popup, and settings.ts DEFAULT_SETTINGS.
//
// Must be safe to evaluate in Node (WXT loads wxt.config.ts at build time) AND
// in service-worker / content-script / popup contexts: keep this module pure
// data + pure functions - no chrome.*, no DOM, no window references.

// The registry row shape. Adding a site is one row in `SUPPORTED_SITES`.
interface SiteDescriptorInput {
  // Lowercase site id.
  site: string;
  // Human-readable brand name shown in the popup's per-site toggle list.
  label: string;
  // Exact hostnames the adapter RUNS on - the manifest content-script match
  // hosts and the `adapter.matches(host)` (run-host) contract.
  hosts: readonly string[];
  // Hosts the URL PARSER accepts when reading a target from a link's href - a
  // SUPERSET of `hosts` for sites whose DOM links use bare/mobile domains the
  // extension doesn't itself run on (e.g. bare `facebook.com`). Defaults to
  // `hosts`; NOT propagated to the manifest.
  urlHosts?: readonly string[];
  // Canonical home URL for the popup's per-site link (Amazon adds regional
  // resolution on top via resolveHomeUrl).
  homeUrl: string;
  // Optional runtime-only catch-all (e.g. Amazon's regional TLDs not worth
  // enumerating in the manifest). Used by detectSupportedSite but NOT propagated
  // to the manifest match patterns - Chrome only accepts explicit globs.
  hostRegex?: RegExp;
  // Optional override for the popup's per-site "home" link (Amazon resolves a
  // regional storefront). Pure: the popup passes in `navigator.language` and
  // the active tab host, so this module stays DOM/window-free.
  resolveHomeUrl?: (activeHost: string | null, lang: string) => string;
}

// Best-guess mapping from a UI language tag to an Amazon regional storefront.
// The lookup tries the full tag before the bare base subtag; deliberately no
// bare "en" entry - "en" alone must not default to .co.uk.
const AMAZON_LOCALE_MAP: Record<string, string> = {
  "en-GB": "www.amazon.co.uk",
  "en-CA": "www.amazon.ca",
  "en-AU": "www.amazon.com.au",
  "en-IN": "www.amazon.in",
  "de-DE": "www.amazon.de",
  "de-AT": "www.amazon.de",
  de: "www.amazon.de",
  "fr-CA": "www.amazon.ca",
  "fr-FR": "www.amazon.fr",
  fr: "www.amazon.fr",
  "it-IT": "www.amazon.it",
  it: "www.amazon.it",
  "es-MX": "www.amazon.com.mx",
  "es-ES": "www.amazon.es",
  es: "www.amazon.es",
  "ja-JP": "www.amazon.co.jp",
  ja: "www.amazon.co.jp",
  "hi-IN": "www.amazon.in",
  hi: "www.amazon.in",
  "pt-BR": "www.amazon.com.br",
  pt: "www.amazon.com.br",
};

function resolveAmazonHomeUrl(activeHost: string | null, lang: string): string {
  // The active tab's host, when it already belongs to Amazon, is the strongest
  // signal of which regional storefront the user wants - "belongs" being the same
  // anchored run-host check as detectSupportedSite, so a look-alike such as
  // `a.amazon.evil.com` never becomes the popup's Amazon link.
  //
  // smile.amazon.com is retired (Amazon shut AmazonSmile down in 2023) and is no
  // longer a run host, but the anchored regional catch-all below still recognises
  // it - so normalise it here, or an old tab would hand the popup a dead link.
  if (activeHost === "smile.amazon.com") return "https://www.amazon.com/";
  if (activeHost && detectSupportedSite(activeHost) === "amazon") return `https://${activeHost}/`;
  const base = lang.split("-")[0] ?? "";
  const host = AMAZON_LOCALE_MAP[lang] || AMAZON_LOCALE_MAP[base] || "www.amazon.com";
  return `https://${host}/`;
}

export const SUPPORTED_SITES = [
  { site: "facebook", label: "Facebook", hosts: ["www.facebook.com", "m.facebook.com"], urlHosts: ["www.facebook.com", "m.facebook.com", "facebook.com"], homeUrl: "https://www.facebook.com/" },
  { site: "instagram", label: "Instagram", hosts: ["www.instagram.com", "instagram.com"], homeUrl: "https://www.instagram.com/" },
  { site: "reddit", label: "Reddit", hosts: ["www.reddit.com", "reddit.com"], homeUrl: "https://www.reddit.com/" },
  { site: "github", label: "GitHub", hosts: ["github.com"], homeUrl: "https://github.com/" },
  { site: "gitlab", label: "GitLab", hosts: ["gitlab.com"], homeUrl: "https://gitlab.com/" },
  // m.youtube.com is PARSE-only: mobile YouTube serves `ytm-*` DOM, which the
  // desktop `ytd-*` selectors in youtube.ts don't match, so running there would
  // request a host the extension can't use. Promote it back to a run host in the
  // same change that adds the mobile selectors (verified on a live mobile page).
  { site: "youtube", label: "YouTube", hosts: ["www.youtube.com", "youtube.com"], urlHosts: ["www.youtube.com", "youtube.com", "m.youtube.com"], homeUrl: "https://www.youtube.com/" },
  { site: "x", label: "X", hosts: ["x.com", "www.x.com"], homeUrl: "https://x.com/" },
  { site: "threads", label: "Threads", hosts: ["threads.com", "www.threads.com"], homeUrl: "https://www.threads.com/" },
  {
    site: "amazon",
    label: "Amazon",
    homeUrl: "https://www.amazon.com/",
    resolveHomeUrl: resolveAmazonHomeUrl,
    hosts: ["www.amazon.com", "www.amazon.co.uk", "www.amazon.de", "www.amazon.fr", "www.amazon.it", "www.amazon.es", "www.amazon.ca", "www.amazon.com.au", "www.amazon.co.jp", "www.amazon.in", "www.amazon.com.br", "www.amazon.com.mx"],
    // Catch regional Amazon TLDs not enumerated above (amazon.nl, amazon.com.tr).
    // Anchored to the end with 2-3-char TLD labels so a look-alike like
    // `a.amazon.evil.com` never matches. Runtime-only - not in the manifest.
    hostRegex: /(?:^|\.)amazon\.[a-z]{2,3}(?:\.[a-z]{2,3})?$/,
  },
] as const satisfies readonly SiteDescriptorInput[];

// DERIVED single source of truth for the site-id union - adding a row above adds
// the id here automatically. Re-exported from `./adapter` for back-compat.
export type SupportedSite = (typeof SUPPORTED_SITES)[number]["site"];

// Widened view for uniform member access: the `as const` above narrows each row
// to its exact literal shape (e.g. `hostRegex` exists only on Amazon's), so read
// rows as `SiteDescriptorInput` while `SupportedSite` keeps the derived union.
const SITES: readonly SiteDescriptorInput[] = SUPPORTED_SITES;

const SITE_BY_ID = new Map<string, SiteDescriptorInput>(SITES.map((s) => [s.site, s]));

export function detectSupportedSite(host: string): SupportedSite | null {
  for (const s of SITES) {
    if (s.hosts.includes(host)) return s.site as SupportedSite;
    if (s.hostRegex?.test(host)) return s.site as SupportedSite;
  }
  return null;
}

// `true` when the site's URL parser accepts `host` for reading a target from a
// link href - the `urlHosts` superset, or `hosts` when none is declared.
// Distinct from `detectSupportedSite` (the run-host contract), which is narrower.
export function urlHostBelongsToSite(host: string, site: SupportedSite): boolean {
  const descriptor = SITE_BY_ID.get(site);
  if (!descriptor) return false;
  return (descriptor.urlHosts ?? descriptor.hosts).includes(host);
}

// `true` when a target URL lives on the site it claims. Run-hosts
// (`detectSupportedSite`, which also covers Amazon's regional `hostRegex`) OR
// the parse-host superset - an exported history row may carry a parse-only host
// like bare `facebook.com`, and re-importing it must not fail.
export function targetUrlBelongsToSite(url: string, site: SupportedSite): boolean {
  try {
    const { hostname } = new URL(url);
    return detectSupportedSite(hostname) === site || urlHostBelongsToSite(hostname, site);
  } catch {
    return false;
  }
}

// The `https://<host>/*` patterns each `entrypoints/<site>.content.ts` must
// declare literally (WXT extracts them statically, so they can't be computed
// there); `content-matches.test.ts` pins the drift. Regex hosts excluded.
export function matchPatternsForSite(site: SupportedSite): string[] {
  const descriptor = SITE_BY_ID.get(site);
  return descriptor ? descriptor.hosts.map((h) => `https://${h}/*`) : [];
}

export const ALL_SITE_MATCH_PATTERNS: readonly string[] = SITES.flatMap((s) => matchPatternsForSite(s.site as SupportedSite));

export const ALL_SITES: readonly SupportedSite[] = SUPPORTED_SITES.map((s) => s.site);

// One per-site record derived from the registry, keyed by the derived site union
// so every lookup below is total. Holds the sole unchecked `fromEntries` cast.
function bySite<T>(pick: (row: SiteDescriptorInput) => T): Record<SupportedSite, T> {
  return Object.fromEntries(SITES.map((s) => [s.site, pick(s)])) as Record<SupportedSite, T>;
}

export const SITE_LABELS: Record<SupportedSite, string> = bySite((s) => s.label);

const SITE_HOME_URLS: Record<SupportedSite, string> = bySite((s) => s.homeUrl);

// The popup's per-site "home" link target - total by construction, no fallback
// URL to invent; Amazon's regional storefront comes from `resolveHomeUrl`.
export function resolveSiteHomeUrl(site: SupportedSite, activeHost: string | null, lang: string): string {
  return SITE_BY_ID.get(site)?.resolveHomeUrl?.(activeHost, lang) ?? SITE_HOME_URLS[site];
}

// Every supported site ships enabled; used by settings.ts DEFAULT_SETTINGS so
// adding a site can't leave it missing from the toggle map.
export const DEFAULT_SITE_TOGGLES: Record<SupportedSite, boolean> = bySite(() => true);
