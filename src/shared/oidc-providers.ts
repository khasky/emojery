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
export const PROVIDER_ID_SHAPE = /^[a-z][a-z0-9-]*$/;

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  google: "Google",
  apple: "Apple",
  microsoft: "Microsoft",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  discord: "Discord",
  twitch: "Twitch",
  slack: "Slack",
};

export function providerLabel(id: OidcProvider): string {
  return PROVIDER_LABELS[id] ?? id;
}

export function isProviderId(value: unknown): value is OidcProvider {
  return typeof value === "string" && value.length <= PROVIDER_ID_MAX && PROVIDER_ID_SHAPE.test(value);
}
