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
pnpm run zip:firefox
```

## Output and verification

The build emits:

- `.output/firefox-mv2/` — the unpacked extension
- `.output/emojery-v<version>-firefox-mv2.zip` — the packaged extension
- `.output/emojery-v<version>-sources.zip` — the source archive

To verify the submitted add-on, compare the rebuilt `.output/firefox-mv2/` directory with the contents of the submitted Firefox extension zip.

5 values are inlined at build time, all defined in `wxt.config.ts`: `__EM_API_BASE_OVERRIDE__` (empty in a release build, so the bundle uses the compiled-in production API origin), `__EM_STAGING_BUILD__` (`false` in a release build), `__EM_DEBUG_LOG__` (`false` in a release build, so the console debug channels and their redactor are dead code and drop out of the bundle), `__EM_I18N_FALLBACK__` (`false` in every build, so the English fallback dictionary that exists only for the unit-test environment drops out of the bundle), and `__EM_BUILD_TIME__` — a `YYYY-MM` (UTC) build stamp shown in the popup header.

The first 4 are constant for a given release build, so the stamp is the only value that changes between rebuilds: a rebuild in the same calendar month is byte-identical to the submitted package; a rebuild in a later month differs only in that string.

## Data collection permissions

The Firefox manifest declares required data collection through `browser_specific_settings.gecko.data_collection_permissions`: `authenticationInfo`, `websiteContent`, and `personallyIdentifyingInfo`. It also declares `technicalAndInteraction` as optional: reaction requests carry optional context fields for aggregate breakdowns only when both the in-extension "Community insights" toggle and Firefox's optional data permission are enabled.

`strict_min_version` is `128.0` on desktop and Android, below the 140/142 floor of Mozilla's built-in consent flow, so that Firefox forks still on the previous ESR can install. Both fallbacks Mozilla asks for on older builds are in place, keyed off `permissions.getAll()` omitting the `data_collection` bucket:

- **Optional data is switched off.** `technicalAndInteractionConsentGranted()` (`src/shared/data-consent.ts`) resolves false when the browser reports no bucket, so no optional context field is ever attached and the popup's "Community insights" toggle cannot turn one on.
- **Required data gets its own disclosure.** A fresh install opens `auth.html?consent=1` (`src/background/install.ts`), which states what is transmitted and links the privacy policy before the sign-in form appears. Firefox 140+/Android 142+ never see it — their own prompt already ran.
