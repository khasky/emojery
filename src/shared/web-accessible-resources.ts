// SPDX-License-Identifier: GPL-3.0-or-later
//
// The packaged files content scripts may fetch, read by wxt.config.ts for the
// manifest's `web_accessible_resources` (same pattern as sites.ts and homepage.ts:
// the manifest derives from src/, it is not hand-written twice).
//
// Why this list is a guarded constant rather than a literal in the config: the
// per-origin `matches` gate that scopes these resources exists on MV3 only. WXT
// builds Firefox as MV2, whose flat resource list has no per-origin form, so on
// that target anything listed here is readable by any page that learns the
// extension's origin. The rule is therefore not "scope it properly" but "list
// nothing whose disclosure would matter". web-accessible-resources.test.ts enforces that:
// its REVIEWED map carries the reason each entry below is safe for any page to read, and
// the test fails on an entry that has none. That map is the single copy of those reasons -
// adding a pattern here means arguing it there.
export const WEB_ACCESSIBLE_RESOURCES = ["icons/*", "emoji-data/*.json", "emoji-sprite/*"] as const;
