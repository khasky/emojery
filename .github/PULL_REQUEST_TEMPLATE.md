<!-- Thanks for contributing to Emojery! -->

## What does this PR do

<!-- A short summary of the change and why it's needed. Link any related issue
     with "Closes #123". -->

## Type of change

- [ ] New site adapter
- [ ] Bug fix
- [ ] Feature / improvement
- [ ] Docs / chore

## Checklist

<!-- One command runs the whole gate, and CI runs the same one. What each step is
     for: CONTRIBUTING.md#pre-pr-gates. -->

- [ ] `pnpm check` passes locally
- [ ] A green `pnpm test` alone is not the gate — it excludes the `*.browser.test.*` specs, which `pnpm check` covers via `pnpm test:browser`

## For a new site adapter

<!-- Delete this section if not applicable. See docs/adding-a-site.md for the full checklist. -->

- [ ] Site registered as one row in `src/shared/sites.ts` (everything else derives from it)
- [ ] Brand glyph added to `SITE_BRAND` (`src/ui/brand-icons.ts`) — the popup's per-site list
- [ ] Adapter + content entrypoint added
- [ ] Unit tests added (`src/adapters/<site>.test.ts`); drift tests green
- [ ] Lockstep row added for a URL-derivable id (`src/adapters/lockstep.test.ts`)
- [ ] E2E scenario added (`e2e/supported-sites.ts` + `.env.e2e.example` URL)
- [ ] Site placed in `DEEP_SITES` or `SMOKE_SITES` with its feed + content URLs (`e2e/site-auth/scenarios.ts`)
- [ ] Supported-sites table row added in `README.md`
- [ ] Staging round-trip verified and noted above (adding-a-site step 11)
