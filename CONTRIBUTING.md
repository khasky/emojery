# Contributing

Contributions are welcome — bug reports, site requests, and pull requests.

- **A new site** is the most common code contribution: [docs/adding-a-site.md](docs/adding-a-site.md) is the end-to-end checklist.
- **To suggest a site** instead of building it, open a [site request issue](https://github.com/khasky/emojery/issues/new?template=site_request.md).
- **To report a bug**, use the extension's Report tab for page-specific bugs, or open a [bug report issue](https://github.com/khasky/emojery/issues/new?template=bug_report.md).
- **A privacy question, a data request, or a legal notice** goes in a [privacy or legal issue](https://github.com/khasky/emojery/issues/new?template=privacy_legal.md); keep the public thread free of personal data and say there what private channel the follow-up needs.
- **Anything else** — a [feature request](https://github.com/khasky/emojery/issues/new?template=feature_request.md) or a [question](https://github.com/khasky/emojery/issues/new?template=question.md).
- **Security problems never go in a public issue** — see [SECURITY.md](./SECURITY.md).

Set up your local build first: [Build from source and development](README.md#build-from-source-and-development). Every PR branches off `main` the [way described below](#branches-and-pull-requests), runs the [gates](#pre-pr-gates), and follows the [commit convention](#commit-messages). Participation is covered by the [Code of Conduct](./CODE_OF_CONDUCT.md). By contributing you agree your work is licensed under [GPL-3.0-or-later](./LICENSE).

## Where each guide lives

[docs/README.md](docs/README.md) indexes every guide with what each one covers, so it stays the one place that list is maintained. The 2 you are likeliest to want from here: [docs/adding-a-site.md](docs/adding-a-site.md) for a new site, and [e2e/README.md](e2e/README.md) for the e2e suites — what each spec covers, how to run them, the env knobs.

## Where a test belongs

This extension's real job (finding and placing the trigger in each site's action row, mounting it, theming it) runs against **live, changeable** page DOM. That coupling is verified only by the e2e suites, which drive a real browser on real pages. The split is a hard rule:

**Unit tests (`src/**/*.test.ts(x)`, Vitest) must not simulate a supported site's page.** Don't build fake X / Facebook / Instagram / Reddit / YouTube / GitHub markup to prove adapter placement, action-row discovery, native replacement, theme/contrast, shadow-DOM mounting, or visual layout. Concretely, a unit test must not:

- build a supported site's page, post card, action row, or native Like/Star/Share control via `innerHTML` / `createElement`;
- call an adapter's `scan()`, or any DOM walk / placement / mount / re-anchor helper, against such a constructed tree;
- read `getBoundingClientRect` or computed styles from one to assert placement, contrast, or row fit.

**Unit tests are expected** for extension-owned behavior: URL/ID parsing (`extractXStatusRef`, `extractFbId`, ...), target-key derivation, host matching (`adapter.matches`), settings and storage, reaction aggregation, vote-flow and queue logic, scan-orchestration contracts with mocked callbacks, and Emojery's own UI — the trigger button, the picker, the popup, accessibility states. jsdom is fine there; the line is whether the test pretends to be a supported site's page.

The same Vitest run also covers the build/maintainer scripts: `vitest.config.ts` includes `scripts/**/*.test.mjs` next to the `src/` globs, so a helper under `scripts/lib/` can carry its own plain-Node self-check.

**Why:** a fake-HTML unit test pins a snapshot of someone else's markup. Sites change their DOM often (logged-out X dropped every `data-testid` at one point); when they do, the real behavior breaks while the fake-HTML test keeps passing — false confidence on top of what e2e already covers on the live page. Characterize a placement bug by capturing the real structure and extending an e2e check instead.

## Fixing a bug

### Codebase map

- `src/adapters/` — per-site adapters + the shared toolkit (framework, placement, labels, URL parsing, observer plugins). Most site-specific bugs live here.
- `src/ui/` — everything Emojery renders and does on the page: `mount.ts` / `mount-registry.ts` (mounting and re-anchoring the shadow-DOM host), `picker.tsx`, `mount-style.ts` (theming/blending) with its pure color math in `mount-color.ts`, `ring-spin.ts` / `themed-hosts.ts` (the 2 host registries the mount registry only prunes), `settings-cache.ts` (the content script's one settings read), `content-entry.ts` (the content-script main every `<site>.content.ts` calls), `vote-client.ts` / `vote-sync.ts` (sending votes, cross-tab sync).
- `src/shared/` — the foundation every other layer builds on, with no per-site knowledge in it: the `sites.ts` registry, `dom.ts` (the class/attribute names of Emojery's injected DOM), `dom-query.ts` (the selector-list queries both layers use) and `adapter.ts` (the `PickerInsertionPoint` contract), both DOM-typed but touching no global, plus `storage.ts` (settings/history), `webext.ts` / `i18n.ts` (the thin `chrome.*` wrappers), `reactions.ts` and emoji search. `theme.ts` is the exception that reads page globals (`document`, `matchMedia`) directly.
- `src/entrypoints/` — WXT entrypoints: one `<site>.content.ts` per site, `background.ts`, `popup/`, `auth/`.
- `e2e/` — live-site black-box suites; `src/**/*.test.ts` holds the unit suites. Which layer a check belongs to is a strict rule; see [where a test belongs](#where-a-test-belongs) and `e2e/README.md`.

### Debugging placement on a live page

Build and load the extension (`pnpm build`, or `pnpm build:staging` when you also need to sign in), open the site, and inspect with DevTools. 2 things to know first:

- **The picker lives in an open shadow root.** Plain `document.querySelector` does not see inside it — query the light-DOM markers below to count mounts, and go through the host's `.shadowRoot` to reach the trigger/picker internals. All names come from `src/shared/dom.ts`:

| What | Selector |
| --- | --- |
| Trigger host (light DOM) | `.khasky-emojery-host` |
| Mount anchor, carries the target key | `[data-khasky-emojery-mounted]` (value: `<site>:<targetId>`) |
| Native control hidden by replace-native | `[data-khasky-emojery-hidden="1"]` |
| Picker overlay host (light DOM) | `.khasky-emojery-overlay-host` |

- **Mounting is lazy.** The trigger mounts as its row approaches the viewport — scroll the item into view and give the page a moment before concluding a mount is missing; below-the-fold rows staying unmounted (marker set, no host yet) is by design.

When placement looks right but behavior is wrong, check the mounted key first: a wrong `<site>:<targetId>` value points at `resolveTarget` / the URL parser, not at placement.

### The fix → verify loop

1. Reproduce on the live page and capture the real DOM around the failure (DevTools → copy `outerHTML`) — don't work from memory of the site's markup.
2. Root-cause in the adapter/toolkit (fix the shared helper, not one call site), then run the narrow gates: `pnpm test src/adapters/<site>.test.ts`, `pnpm compile`, `pnpm lint`.
3. Re-verify on the live page with a rebuilt extension. If the bug was placement/DOM-shaped, extend the matching e2e scenario — never add a fake supported-site DOM unit test.

## Branches and pull requests

`main` is the only long-lived branch, and it is always releasable: every store submission is built from a `v*` tag on `main`, so anything merged there has already passed the [gates below](#pre-pr-gates). There is no `develop` branch — 1 version of the extension is live at a time, so a second integration branch would only double the merge work for no isolation gained. Staging is a build mode (`pnpm build:staging`), not a branch.

Outside contributors work in a fork; the branches in this repo belong to the maintainer and to Dependabot. The flow is the same either way:

```bash
git switch -c fix/instagram-comment-rows main
# commits following the convention below
pnpm check
git push -u origin fix/instagram-comment-rows
```

- **Name the branch after the commit type it carries** — `feat/...`, `fix/...`, `docs/...`, `refactor/...`, `perf/...`, `ci/...`, `chore/...`.
- **One branch, one change**, opened as a PR while it is still small. A branch that outlives a few days spends that time fighting `main` instead of the bug.
- **Target `main`** — it is the only branch that takes pull requests.

PRs land as a **squash merge**, so `main` keeps a linear history where 1 PR is 1 commit and 1 line in `CHANGELOG.md`. That squashed commit takes its message from the **PR title**, not from the commits inside the branch, so the title itself has to follow [the convention](#commit-messages) (`fix(instagram): don't double-mount on comment rows`) even when every commit in the branch already does — the release version and changelog are derived from what lands on `main`. The head branch is deleted on merge.

`release/<major>.<minor>` branches exist only when a version already shipped to the stores needs a patch after `main` has moved past it. They are cut on demand and are maintainer-only: [docs/releasing.md](docs/releasing.md#hotfixing-a-released-version).

## Pre-PR gates

`pnpm check` runs the whole gate in one command; CI (`.github/workflows/ci.yml`) runs the same list on every PR, and it must be green:

```bash
pnpm compile           # tsc --noEmit (src)
pnpm compile:e2e       # both e2e tsconfigs - the specs and site-auth/, neither of which their runner type-checks
pnpm compile:scripts   # the build/maintainer scripts, which no other tsconfig covers
pnpm lint              # biome check --error-on-warnings (format check + lint + import order; warnings fail too)
pnpm lint:docs         # markdownlint over every tracked .md (biome does not read Markdown)
pnpm test:coverage     # vitest run plus the coverage report - informational, no thresholds
pnpm test:e2e:hermetic # the one e2e project that needs neither a browser nor the network
pnpm test:browser      # the WebKit + Firefox component tests (one-time: pnpm exec playwright install webkit firefox)
pnpm build:all         # wxt build, chrome + firefox
pnpm check:bundle      # per-content-script byte budget + no English message dictionary in a bundle
pnpm zip:all           # wxt zip, chrome + firefox
```

`pnpm test:browser` dying in seconds with `page.goto: Page crashed` / `Browser connection was closed while running tests` and `Tests no tests` is a stale WebKit binary, not a broken suite — the `webkit-<rev>` under the Playwright browsers directory no longer matches the pinned `playwright`. Re-run `pnpm exec playwright install webkit`. A WebKit that launches and loads an ordinary page proves nothing here: only a bundle as heavy as the Vitest tester page crashes the mismatched build (seen on Windows with WebKit v2311, fixed by v2336). The pinned `firefox-<rev>` binary can go stale the same way — `pnpm exec playwright install firefox`.

`pnpm test` (plain `vitest run`) is the fast inner loop, not the gate: it excludes the browser-mode specs (`*.browser.test.*`, which run under `test:browser` in real WebKit and Firefox), so a green `pnpm test` says nothing about them. `test:coverage` adds the report and nothing else — `vitest.config.ts` sets no thresholds, so coverage never fails a run either way. Same for `pnpm build` / `pnpm zip` — CI builds and packages both browsers.

3 CI steps have no local equivalent and need nothing from you: after the build it scans the generated Chrome output, the generated Firefox output, and the AMO source archive for committed secrets (`scripts/scan-extension-artifact.sh`, `scripts/scan-source-archive.sh`).

## What CI runs, and when

`ci.yml` and `security.yml` are the workflows your PR triggers — between them they run the gate above. The scheduled ones watch things no diff controls: a site's markup, a browser channel, a newly published CVE. A red scheduled run is a maintainer signal, not a review comment. All 8 workflows in `.github/workflows/`:

| Workflow | Cadence | Watches |
| --- | --- | --- |
| `ci.yml` | every PR + every push to `main` | this repo's own code — the gate above |
| `security.yml` | every PR, and daily | OSV Scanner, Gitleaks, Semgrep |
| `selector-drift.yml` | daily | whether each scenario URL still serves the native controls the adapters anchor on |
| `e2e-ci.yml` | every other day + weekly | live-page placement, replace-native, theme contrast |
| `edge-smoke.yml` | every other day | the GitHub + YouTube placement pair in real Edge |
| `a11y.yml` | every other day | the extension's own pages (axe, keyboard walk, reflow) |
| `mirror.yml` | every push and tag, plus daily | nothing — one-way push mirrors to the GitLab, Codeberg and Bitbucket copies, plus a Software Heritage archive request |
| `release.yml` | a `v*` tag, or manual dispatch | nothing — it packages and attaches the store builds |

Per-suite detail (what each spec asserts and when it skips) is in [e2e/README.md](e2e/README.md). Runs and logs are public: the [Actions tab](https://github.com/khasky/emojery/actions) shows every one.

## Commit messages

This repo follows [Conventional Commits](https://www.conventionalcommits.org/). A `commit-msg` hook (husky + commitlint, installed automatically on `pnpm install`) rejects messages that don't parse, so the format never drifts and the changelog and version are derived straight from history.

Shape — `type(scope)?: subject`:

```text
feat(mastodon): add adapter
fix(instagram): don't double-mount the picker on comment rows
docs: explain the commit convention
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `style`, `test`, `build`, `ci`, `chore`, `revert`. The version bump derives from the commits since the last release: a breaking change bumps major, `feat` minor, anything else patch. `feat`, `fix`, `perf`, `refactor`, and `revert` show up in `CHANGELOG.md`; the rest (`docs`, `style`, `test`, `build`, `ci`, `chore`) are hidden from it. The header and the body lines are capped at 100 characters (commitlint enforces both). Footer lines are not: a trailer can carry an advisory URL, a GHSA id or a commit sha, and those are one unbreakable token — so anything too long to wrap goes in a trailer (`Refs: <url>`), not mid-paragraph.

**`chore` and `style` are hidden from the changelog, so nothing a user can see may hide behind them.** `chore` is housekeeping invisible from the outside — dependency bumps, config, release chores. `style` is formatting with no semantic effect: import order, whitespace, a wrap that satisfies biome. A changed UI string, a moved button, a colour, a locale file, a security hardening — those are `fix` or `feat` with the scope of the area, however small the diff. A security fix that never reaches `CHANGELOG.md` is the worst case of this, since the changelog is how someone decides whether to update.

Scope is the site id or the area touched, and it is optional. `commitlint` carries the list of scopes already in use and **warns** on anything else: the warning is there to catch a typo or a second name for an area that has one (`ally` for `a11y`, `store-assets` for `assets`), not to block a new area — a scope that's genuinely new lands with the warning, and the list grows in `commitlint.config.js`.

Commitlint enforces 2 footers outright:

- **`revert` needs `Refs: <sha>`** naming the commit it undoes. Prose in the body is for the why; the trailer is what pairs the two commits.
- **A `!` header needs a `BREAKING CHANGE: <what breaks>` footer.** The `!` says something breaks and can't say what; the footer is the line that lands under **Breaking Changes** in `CHANGELOG.md`.

```text
revert(e2e): drop the live-site pill visual baselines

Two of fifteen clips drifted past the 5% budget within an hour with no
code change.

Refs: 79a8186
```

PRs land as a squash merge, so what reaches `main` is the **PR title** — the `commit-msg` hook can't see it, and `ci.yml` validates its shape instead. Keep one concern per commit and per PR: a title that needs a comma-separated list of changes is two PRs.

## Localization

Emoji labels and search work in 26 languages — sourced from Unicode CLDR via `emojibase-data`, pruned at build time, and bundled as static per-locale files. See [docs/localization.md](docs/localization.md) for how the locale data is generated, bundled, fetched, and looked up.

### Translations, and how good they actually are

The extension's own UI strings are a separate dataset from the emoji labels: one `public/_locales/<locale>/messages.json` per shipped language, with the same key set in all 26 (`src/shared/i18n-locales.test.ts` fails on a key present in one and missing from another, and on one left untranslated).

**English, Russian, and Ukrainian are translated by people who speak them. The other 23 languages are machine translation** — produced with a neural model and never reviewed by a native speaker. They ship because a rough translation beats an English-only UI for someone who doesn't read English, not because they read well: expect stiff phrasing, the wrong register, and terms nobody would use for a browser extension in that language.

Fixing that is the easiest way to contribute here — no build, no code, one file:

1. Edit the `message` values in `public/_locales/<locale>/messages.json`. Never rename or add a key; English (`public/_locales/en/messages.json`) is the source of truth for which keys exist, and its `description` fields are the context for what each string means.
2. Keep every `$PLACEHOLDER$` exactly as the English string spells it, along with the entry's `placeholders` block. A placeholder used but not defined fails the **whole extension load** in that language, not just that one string.
3. Watch the width. Buttons, the popup and the picker are narrow; a string twice its English length overflows the control.
4. Run `pnpm verify:locales` and `pnpm test` before opening the PR — `src/shared/i18n-locales.test.ts` checks key parity, placeholders, and that nothing is left empty.
5. One language per pull request, `fix(i18n): ...` (see [Commit messages](#commit-messages)), and say in the description that you speak it — nobody here can review a language they don't read, so that statement is the review.

Adding a language that isn't in the 26 is a bigger change than a `messages.json` file — see [Adding or removing a locale](docs/localization.md#adding-or-removing-a-locale) and open an issue first.
