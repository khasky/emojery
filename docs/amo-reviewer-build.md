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

To verify the submitted add-on, rebuild it from the tagged source and compare the rebuilt `.output/firefox-mv2/` directory with the contents of the submitted Firefox extension zip.

Two things in the source are absent from that output, both by a build-time constant in `wxt.config.ts`: the console debug channels and their redactor (`__EM_DEBUG_LOG__`), and the English fallback dictionary that exists only for the unit-test environment (`__EM_I18N_FALLBACK__`). `__EM_API_BASE__` is why the API origin appears in the bundle as a literal; it comes from `src/shared/api-origins.ts`.

## Linter warnings

`web-ext lint` on the submitted package reports 0 errors and 17 warnings, and every one of them is expected.

**15 × `UNSAFE_VAR_ASSIGNMENT`** — one per bundle that carries Preact: the 14 site content scripts and the shared `tracking-links` chunk. Each points at Preact's own `dangerouslySetInnerHTML` branch (`f.__html == e.innerHTML || (e.innerHTML = f.__html)`), which lands in each bundle separately because MV3 content scripts get no code splitting. Nothing in this extension reaches it: no source file passes that prop — `biome.jsonc` enables `security/noDangerouslySetInnerHtml` and `pnpm lint` runs `biome check --error-on-warnings`, so a first use fails the build — and every `grep -rn innerHTML src` hit over the source archive sits in a test file, the vitest DOM reset among them, none of which ship in an artifact.

**`KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION` and `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`** — `strict_min_version` sits below the 140/142 floor that introduced `data_collection_permissions`, deliberately; the next section has the reason and the disclosure that covers the builds below it.

## Data collection permissions

The Firefox manifest declares its data collection through `browser_specific_settings.gecko.data_collection_permissions`, all of it required: `authenticationInfo`, `websiteActivity`, `websiteContent` and `locationInfo`. Nothing is optional: the extension collects no analytics and has no toggle that would collect more. [permissions.md](permissions.md#firefox-data-collection-permissions) says what each category covers.

`strict_min_version` is `130.0` on desktop and Android: the device key that signs every reaction is an Ed25519 WebCrypto key, which Firefox has from 130. That is below the 140/142 floor of Mozilla's built-in consent flow, so builds 130 to 139 (Android 130 to 141) never see Mozilla's prompt. The disclosure Mozilla asks for on those builds is in place, keyed off `permissions.getAll()` omitting the `data_collection` bucket (`needsLegacyDataConsentNotice()` in `src/shared/data-consent.ts`): a fresh install opens `auth.html?consent=1` (`src/background/install.ts`), which states what is transmitted and links the privacy policy before the sign-in form appears. Firefox 140+/Android 142+ never see it — their own prompt already ran.
