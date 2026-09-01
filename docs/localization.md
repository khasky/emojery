# Emoji labels & multilingual search

Every emoji in the picker has a localized human-readable name (used for the breakdown row, `title` tooltip, and `aria-label`) and a set of search keywords. Both come from the **Unicode Common Locale Data Repository (CLDR)** via the `emojibase-data` package. There is no curated label list to maintain; CLDR covers every emoji in the primary locales Emojery ships.

## Locales

Emojery ships compact data for primary locales only: `bn, da, de, en, es, et, fi, fr, hi, hu, it, ja, ko, lt, ms, nb, nl, pl, pt, ru, sv, th, uk, vi, zh, zh-hant`. Regional near-duplicates fall back to the base language, for example `es-MX` uses `es`; English variants like `en-GB` resolve to `en`. All are bundled into the extension package as static resources under `public/emoji-data/<locale>.json`, pruned at build time (see "Pruning" below). The locale is detected by walking `navigator.languages` in order (falling back to `navigator.language` when that list is empty) and taking the first entry that resolves to a shipped locale, and the matching file is fetched on demand via `chrome.runtime.getURL`. English is always fetched too, as the universal fallback: an English UI loads 1 file, any other locale loads 2. Run `pnpm copy:emoji-data` and look at `public/emoji-data/` for the current sizes.

## Lookup order

`shared/emoji-meta.ts` keeps 2 maps in memory, both lazy-fetched the first time the picker mounts:

1. **Locale map** — the data for the first of the user's `navigator.languages` that resolves to a shipped locale (`loadLocaleMap`), absent when none of them do.
2. **English map** — `ensureEnLoaded()` fetches `public/emoji-data/en.json` through the same path, as the universal label and search floor.

`ensureLocaleLoaded()` starts both and awaits them together, so whoever awaited it can search in English immediately even if the primary locale is still missing.

`getEmojiLabel(emoji)` returns the locale label, falls back to the English label, then to the emoji character itself.

`searchEmojis(query, candidates)` matches the query against both maps' labels and `tags` (CLDR's localized keyword list), so a French user typing `amour` and a Japanese user typing `愛` both find ❤️.

## Why static resources, not `import()`

Content scripts in MV3 have no code-splitting — Vite/WXT inline every dynamic `import()` into the content-script bundle. Wiring locales as imports puts the entire raw emojibase payload into every content script, orders of magnitude past what the byte budget in `scripts/check-bundle-budget.mjs` allows. Storing them as static files under `public/emoji-data/` and fetching them with `chrome.runtime.getURL()` keeps each content script down to UI + adapters. English is fetched at runtime for the same reason rather than imported: even pruned, a statically bundled English set lands whole in every content script.

## Cross-browser

- `chrome.runtime.getURL()` and `web_accessible_resources` are part of the WebExtensions standard, available on Chrome, Edge, Firefox, and Safari (WebExtensions framework).
- WXT's manifest builder declares `emoji-data/*.json` in `web_accessible_resources` for every supported host so content scripts can fetch the files without CSP issues.

## How the locale files get there

1. `pnpm install` runs `postinstall` which calls `wxt prepare` plus `node scripts/copy-emoji-locales.mjs`.
2. The script walks `node_modules/emojibase-data/<locale>/`, keeps only the locales in its own `PUBLIC_EMOJI_LOCALES` allowlist (the 26 above, English included), prunes each `compact.json` (see "Pruning"), and writes the result to `public/emoji-data/<locale>.json`. Everything else emojibase ships is skipped: the regional duplicates that fall back to a base language (`en-gb`, `es-mx`) and its non-locale `meta` / `versions` directories. A `public/emoji-data/*.json` file whose locale left the allowlist is deleted on the next run. The script also emits `src/shared/__generated__/messages-en.json`: the English fallback for the extension's **own UI strings**, a separate dataset from the emoji labels described here.
3. `pnpm dev`, `pnpm build`, `pnpm zip`, and their browser variants run `prepare:assets` before WXT — safe to re-run, idempotent. That script is `copy:emoji-data` plus `verify:locales`, so a `$PLACEHOLDER$` used without its `placeholders` block in any `public/_locales/*/messages.json` stops the build rather than shipping a locale that fails to load.

### Adding or removing a locale

Re-running `pnpm copy:emoji-data` alone changes nothing — the shipped set is 3 hand-maintained lists, and a new language is only live once all 3 carry it:

| List | Where | What it controls |
| --- | --- | --- |
| `PUBLIC_EMOJI_LOCALES` | `scripts/copy-emoji-locales.mjs` | Which `public/emoji-data/<locale>.json` files are generated at all |
| `SUPPORTED_LOCALE_KEYS` | `src/shared/emoji-meta.ts` | Which browser languages `detectLocaleKey()` resolves to a shipped file |
| `public/_locales/<locale>/` | Chrome i18n message catalogs | The extension's **own UI strings** (a separate dataset from emoji labels) |

The third list is the extension's own UI strings, whose translation quality differs per language — English, Russian and Ukrainian are human, the rest is machine translation. [CONTRIBUTING.md → Translations](../CONTRIBUTING.md#translations-and-how-good-they-actually-are) covers that and how to send a fix.

The first two must match except for `en`, deliberately absent from `SUPPORTED_LOCALE_KEYS` because it is never the *detected* locale: `ensureEnLoaded()` loads it unconditionally as the fallback. Nothing pins the lists to each other automatically, so change them in one commit; a key in `SUPPORTED_LOCALE_KEYS` with no generated file makes the loader return `null` and the picker falls back to English.

## Pruning

emojibase's compact format ships every emoji Unicode defines, per locale, plus full `skins` arrays for skin-tone variations. The picker only ever looks up emojis in `REACTIONS` (the flat list derived from `CATEGORIES` in `shared/reactions.ts`) and has no skin-tone UI, so every other entry (and every field besides `unicode` / `label` / `tags`) is dead weight.

`scripts/copy-emoji-locales.mjs` prunes every locale through 2 helpers:

- `readPaletteKeepSet()` (`scripts/lib/emoji-palette.mjs`) reads the palette from `src/shared/__data__/emoji-categories.json` and returns it as a lookup set holding **both** the original and the VS-16-stripped form of each emoji, mirroring `addEntry` in `emoji-meta.ts` at runtime. The palette lives in JSON rather than in `reactions.ts` precisely so build-time readers need a `JSON.parse` instead of a regex over TypeScript source. The sprite builder reads the same file (`readPaletteEmojis()`), so the sprite sheet and the label data can't drift apart.
- `pruneCompactData(data, keep)` (`scripts/lib/prune-emoji-data.mjs`) drops `hexcode`, `group`, `order`, the entire `skins` sub-array, and any entry not in the keep set, then emits a minimal `{ unicode, label?, tags? }` shape.

Net result: the raw emojibase payload shrinks by roughly an order of magnitude on disk in `public/emoji-data/`, and it is fetched 1 or 2 files at a time instead of bundled. Both sides are measurable at any time (`node_modules/emojibase-data/` before, `public/emoji-data/` after), so no figure is repeated here to go stale.
