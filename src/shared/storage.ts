// SPDX-License-Identifier: GPL-3.0-or-later
//
// The import point for the three storage modules below - every consumer in the repo
// goes through this barrel, and new code should too. Not an aspiration: `vi.mock`
// binds to the specifier string, so importing `./counts-cache` or `./target-store`
// directly silently escapes every suite that mocks `shared/storage` (verified -
// repointing ui/settings-cache.ts alone broke two vote-client tests). Reach past the
// barrel only together with the mocks that would stop covering that call site.

export * from "./counts-cache";
export * from "./settings";
export * from "./target-store";
