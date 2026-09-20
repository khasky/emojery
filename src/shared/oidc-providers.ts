// SPDX-License-Identifier: GPL-3.0-or-later
//
// The sign-in providers as the auth page names them. WHICH providers exist is the
// API's answer (`GET /auth/oidc/providers`), so a provider added or retired on the
// backend reaches the page without a release; this module only knows how to label
// one, and a label it lacks falls back to the id itself.

// A provider id as the API spells it: a lowercase slug. Held to a size and a shape
// by the message guard before it reaches the background.
export type OidcProvider = string;
export const PROVIDER_ID_MAX = 32;
const PROVIDER_ID_SHAPE = /^[a-z][a-z0-9-]*$/;

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
  facebook: "Facebook",
  twitch: "Twitch",
  slack: "Slack",
};

export function providerLabel(id: OidcProvider): string {
  return PROVIDER_LABELS[id] ?? id;
}

// Where to send a reader whose provider cannot be asked to reopen its account
// picker (`chooser` in GET /auth/oidc/providers). Apple is the one today: it
// ignores an OpenID `prompt` rather than refusing it (measured 2026-09-20: the
// authorization page comes back byte-identical with and without one), so there is
// no request that makes it ask. The only way to another Apple Account is ending
// the session Apple holds, which is what this page is for - and only when Apple
// continued on its own, since a browser with no Apple session is asked which
// account anyway. A provider absent from both lists gets no control rather than
// one that would lead nowhere.
const PROVIDER_ACCOUNT_URL: Readonly<Record<string, string>> = {
  apple: "https://account.apple.com/",
};

export function providerAccountUrl(id: OidcProvider): string | null {
  return PROVIDER_ACCOUNT_URL[id] ?? null;
}

// The providers the sign-in page shows straight away, in this order - the accounts
// most people already carry. Everything else the API offers waits behind "more
// sign-in options", in the order the API listed it, so a provider added or retired
// on the backend still needs no release here.
export const FEATURED_PROVIDERS: readonly OidcProvider[] = ["google", "apple", "microsoft"];

export function splitFeaturedProviders(ids: readonly OidcProvider[]): { featured: OidcProvider[]; rest: OidcProvider[] } {
  return {
    featured: FEATURED_PROVIDERS.filter((id) => ids.includes(id)),
    rest: ids.filter((id) => !FEATURED_PROVIDERS.includes(id)),
  };
}

export function isProviderId(value: unknown): value is OidcProvider {
  return typeof value === "string" && value.length <= PROVIDER_ID_MAX && PROVIDER_ID_SHAPE.test(value);
}
