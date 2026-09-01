// SPDX-License-Identifier: GPL-3.0-or-later

// The onboarding page's "Try it live" target: must be a supported-site page that
// renders for a logged-out visitor (GitHub is the only supported site with no
// login wall or bot check), and the keyless #emojery-react hint auto-opens the
// picker on the first mount there (shared/deep-link.ts) - the extension's own
// public repo. Lives here, not in onboarding/main.tsx, so the onboarding e2e can
// import it instead of repeating the URL (that module renders on import).
export const TRY_IT_LIVE_URL = "https://github.com/khasky/emojery#emojery-react";

const EXTENSION_UTM_SOURCE = "emojery";
const EXTENSION_UTM_MEDIUM = "browser_extension";

type ExtensionUtmOptions = {
  campaign: string;
  content: string;
};

export function withExtensionUtm(href: string, { campaign, content }: ExtensionUtmOptions): string {
  const url = new URL(href);
  url.searchParams.set("utm_source", EXTENSION_UTM_SOURCE);
  url.searchParams.set("utm_medium", EXTENSION_UTM_MEDIUM);
  url.searchParams.set("utm_campaign", campaign);
  url.searchParams.set("utm_content", content);
  return url.toString();
}
