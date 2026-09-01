// SPDX-License-Identifier: GPL-3.0-or-later
//
// Per-site content URLs the authenticated bridge suite drives. These are
// *logged-in* surfaces (real feeds / detail pages the signed-in user sees),
// not the public unauth URLs the deterministic `test:e2e` suite uses. Every URL
// is overridable per run via `E2E_AUTHURL_<SITE>` so a tester can point at a
// stable post/repo without editing code.

import type { SupportedSite } from "../../src/shared/sites";
import { requiredEnvUrl } from "../lib/test-config";

// Derived from the site registry, not restated: adding a row to SUPPORTED_SITES
// widens this union, and the coverage guard in
// src/shared/e2e-site-coverage.test.ts fails `pnpm test` until the new site
// lands in DEEP_SITES or SMOKE_SITES (and its env fixtures exist).
export type SiteId = SupportedSite;

// Every site runs the reaction round-trip and the lifecycle mount / no-duplicate-keys
// check; "deep" sites additionally get the heavy-feed passes (deep = the bot-sensitive,
// feed-heavy platforms; smoke = the stable ones).
export const DEEP_SITES: readonly SiteId[] = ["facebook", "instagram", "reddit", "threads", "x"];
export const SMOKE_SITES: readonly SiteId[] = ["youtube", "github", "gitlab", "amazon"];

// NO live URLs in code: every fixture lives in `.env.e2e.example` (the
// checked-in set) or a tester's `.env.e2e` / `.env.e2e.local` override. A
// missing key fails the test that needs it with the key's name, so a stale or
// deleted fixture is re-pointed in the env files, never in a source edit.
// Enforced by requiredEnvUrl (../lib/test-config), which every helper below uses.

// Logged-in FEED / surface - the signed-in user sees real posts with real
// action rows here. Used by the lifecycle flow (virtualization, multiple hosts).
export function authFeedUrl(site: SiteId): string {
  return requiredEnvUrl(`E2E_AUTHURL_${site.toUpperCase()}`);
}

// Stable SINGLE-TARGET content used by the reaction round-trip, so the
// persistence-after-reload check reads the same target back (a feed reorders on
// reload and would make persistence unreliable). Detail/permalink pages for the
// social sites; the same stable content for the rest.
export function authContentUrl(site: SiteId): string {
  return requiredEnvUrl(`E2E_AUTHURL_${site.toUpperCase()}_DETAIL`);
}

// Logged-in Facebook GROUP surface. The aggregated groups feed only has posts
// when the signed-in account is a member of at least one active group, so the
// group-feed check treats "no articles at all" as a setup skip, not a failure.
export function authFacebookGroupUrl(): string {
  return requiredEnvUrl("E2E_AUTHURL_FACEBOOK_GROUP");
}

// Facebook permalink whose PINNED TOP COMMENT carries photo attachments - the
// comment-surface regression's shape (see comment-surface.test.ts).
export function authFacebookPinnedUrl(): string {
  return requiredEnvUrl("E2E_AUTHURL_FACEBOOK_PINNED");
}

// Wall-coverage fixtures (wall-coverage.test.ts): a profile wall and a SPECIFIC
// group wall the signed-in account can read (unlike E2E_AUTHURL_FACEBOOK_GROUP,
// which defaults to the aggregated groups feed), plus one group post permalink.
export function authFacebookProfileWallUrl(): string {
  return requiredEnvUrl("E2E_AUTHURL_FACEBOOK_WALL");
}

export function authFacebookGroupWallUrl(): string {
  return requiredEnvUrl("E2E_AUTHURL_FACEBOOK_GROUP_WALL");
}

export function authFacebookGroupPostUrl(): string {
  return requiredEnvUrl("E2E_AUTHURL_FACEBOOK_GROUP_DETAIL");
}

// Threads REPLY-PREVIEW surface: a profile's replies tab, where every unit is an
// original post plus that account's reply as SIBLING pressables - the shape the
// reply-preview check hunts. The home feed carries it too, but far too rarely to
// check against: measured live, one such unit in ~128 pagelet observations over
// an 18-step scroll, so a feed-driven run skipped nearly every time. Kept a
// separate key from E2E_AUTHURL_THREADS, which must stay the real home feed for
// the deep-scroll and mount checks.
export function authThreadsRepliesUrl(): string {
  return requiredEnvUrl("E2E_AUTHURL_THREADS_REPLIES");
}

// Instagram CAROUSEL (multi-image) post. There is no stable public default that
// is guaranteed to stay a carousel, so the check runs only when the tester
// points `E2E_AUTHURL_INSTAGRAM_CAROUSEL` at one; it also verifies the Next
// arrow is actually present and skips (with a note) when it isn't.
export function authInstagramCarouselUrl(): string | null {
  return process.env.E2E_AUTHURL_INSTAGRAM_CAROUSEL?.trim() || null;
}

export const ALL_SITES: readonly SiteId[] = [...DEEP_SITES, ...SMOKE_SITES];
