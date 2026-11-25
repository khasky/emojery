// SPDX-License-Identifier: GPL-3.0-or-later

// The onboarding page's "Try it live" target: must be a supported-site page that
// renders for a logged-out visitor, and the keyless #emojery-react hint auto-opens
// the picker on the first mount there (shared/deep-link.ts). The extension's own
// public repo is the page chosen for it. Lives here, not in onboarding/main.tsx, so
// the onboarding e2e can import it instead of repeating the URL (that module renders
// on import).
export const TRY_IT_LIVE_URL = "https://github.com/khasky/emojery#emojery-react";

// The one refusal a reader cannot act on from inside the extension: the account
// has registered as many new devices as a day allows. What to do about it depends
// on facts the page does not have (another profile, the time, whether to ask the
// operator), so the article carries them and can be corrected without a release.
// The sign-in page links here from that refusal.
export const HELP_DEVICE_LIMIT_URL = "https://emojery.app/help/device-limit-reached";

// What a reaction publishes, read off one real log entry: linked from the
// public-log agreement on the sign-in page.
export const HELP_WHAT_IS_PUBLIC_URL = "https://emojery.app/help/what-is-public";

// Why only personal accounts sign in, and how to tell a work or school account:
// linked from the refusal the API gives one. The API names the same article in
// its answer; the address is held here so the page links nothing it was sent.
export const HELP_SIGNING_IN_URL = "https://emojery.app/help/signing-in";

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
