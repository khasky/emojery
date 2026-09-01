// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared fixtures for adapter unit tests. Imported only from `*.test.ts`.
// No DOM factories live here: simulating a supported site's action-row DOM is
// an e2e concern (live pages), never a unit fixture.
import { expect } from "vitest";
import type { SiteAdapter, SupportedSite } from "../shared/adapter";
import { SUPPORTED_SITES } from "../shared/sites";

// Assert an adapter matches exactly its registry RUN-hosts (and not unrelated
// hosts). Each `<site>.test.ts` calls this instead of hand-listing the hosts, so
// a new site's host test is one line. Site-specific negatives (e.g. the parse-host
// `facebook.com` that must NOT be a run host) stay in the test.
export function expectMatchesRegistryHosts(adapter: SiteAdapter, site: SupportedSite): void {
  const descriptor = SUPPORTED_SITES.find((s) => s.site === site);
  expect(descriptor, `no registry descriptor for "${site}"`).toBeTruthy();
  for (const host of descriptor?.hosts ?? []) {
    expect(adapter.matches(host), `${site} should match ${host}`).toBe(true);
  }
  expect(adapter.matches("evil.example")).toBe(false);
  expect(adapter.matches("notarealsite.test")).toBe(false);
}
