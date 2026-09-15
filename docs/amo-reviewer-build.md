# AMO reviewer build

Reproducible build instructions for the Firefox package submitted to addons.mozilla.org (AMO).

The Firefox package is built with [WXT](https://wxt.dev/), Vite, and pnpm from the checked-in source. The source archive includes `package.json`, `pnpm-lock.yaml`, and `pnpm-workspace.yaml`; no private packages, environment files, or hosted build services are required.

## Environment

- Node.js 24 or newer
- pnpm — pinned by the `packageManager` field in `package.json`; corepack provisions that exact version in the steps below (no separate install)

## Build steps

From the unzipped source archive:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm run zip:production:firefox
```

## Output and verification

The build emits:

- `.output/firefox-mv2/` — the unpacked extension
- `.output/emojery-v<version>-firefox-mv2.zip` — the packaged extension
- `.output/emojery-v<version>-sources.zip` — the source archive
- `.output/build-records/firefox-mv2/<id>.json` — the digest of the package, outside it

To verify the submitted add-on, compare the rebuilt `.output/firefox-mv2/` directory with the contents of the submitted Firefox extension zip. The production build takes nothing from the clock or the environment, so the two are byte-identical whenever the rebuild is run.

Two things in the source are absent from that output, both by a build-time constant in `wxt.config.ts`: the console debug channels and their redactor (`__EM_DEBUG_LOG__`), and the English fallback dictionary that exists only for the unit-test environment (`__EM_I18N_FALLBACK__`). `__EM_API_BASE__` is why the API origin appears in the bundle as a literal; it comes from `src/shared/api-origins.ts`.

### `build-context.json`

The package carries one generated file, `build-context.json`, holding the sorted path of every file in the package and an id for the build. At run time the background reads those files back, hashes their contents and sends the result to the API, which can then tell which build a request came from. The digest the API compares against is written outside the package (`.output/build-records/`) and never ships.

No user data is involved and nothing is fetched to produce it. The whole exchange is 2 request headers and 1 response header (`x-emojery-build-*`), all computed from files already in the package, and a build that fails to measure itself sends none of them. The file is written after the bundle it describes, so a rebuild regenerates it from the rebuilt output and the comparison above still holds.

## Linter warnings

`web-ext lint` on the submitted package reports 0 errors and 12 warnings, and every one of them is expected.

**10 × `UNSAFE_VAR_ASSIGNMENT`** — one per bundle that carries Preact: the 9 site content scripts and the shared `tracking-links` chunk. Each points at Preact's own `dangerouslySetInnerHTML` branch (`f.__html == e.innerHTML || (e.innerHTML = f.__html)`), which lands in each bundle separately because MV3 content scripts get no code splitting. Nothing in this extension reaches it: no source file passes that prop — `biome.jsonc` enables `security/noDangerouslySetInnerHtml` and `pnpm lint` runs `biome check --error-on-warnings`, so a first use fails the build — and every `grep -rn innerHTML src` hit over the source archive sits in a test file, the vitest DOM reset among them, none of which ship in an artifact.

**2 × `KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION`** (desktop and Android) — `strict_min_version` sits below the 140/142 floor that introduced `data_collection_permissions`, deliberately; the next section has the reason and the 2 fallbacks that cover the builds below it.

## Data collection permissions

The Firefox manifest declares required data collection through `browser_specific_settings.gecko.data_collection_permissions`: `authenticationInfo`, `websiteContent`, and `personallyIdentifyingInfo`. It also declares `technicalAndInteraction` as optional: reaction requests carry optional context fields for aggregate breakdowns only when both the in-extension "Community insights" toggle and Firefox's optional data permission are enabled.

`strict_min_version` is `128.0` on desktop and Android, below the 140/142 floor of Mozilla's built-in consent flow, so that Firefox forks still on the previous ESR can install. Both fallbacks Mozilla asks for on older builds are in place, keyed off `permissions.getAll()` omitting the `data_collection` bucket:

- **Optional data is switched off.** `technicalAndInteractionConsentGranted()` (`src/shared/data-consent.ts`) resolves false when the browser reports no bucket, so no optional context field is ever attached and the popup's "Community insights" toggle cannot turn one on.
- **Required data gets its own disclosure.** A fresh install opens `auth.html?consent=1` (`src/background/install.ts`), which states what is transmitted and links the privacy policy before the sign-in form appears. Firefox 140+/Android 142+ never see it — their own prompt already ran.
