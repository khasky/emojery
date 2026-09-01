# Emojery — e2e tests

3 suites, all fully **black-box**: 2 drive the extension, and the extension-less `selector-drift/` probe (below) watches the sites themselves. On the live-site runs nothing manipulates the DOM or storage to fake state: they drive the browser like a real user and assert on what the user can see — the shadow-hosted trigger/counter, the picker, hidden native controls, `auth.html`.

5 specs are deliberate exceptions, each for a state a real user cannot reach in a test:

- `history-pagination.spec.ts` seeds its rows straight into the background's IndexedDB. Nobody clicks out 10,000 votes.
- `private-pages.spec.ts` rewrites the served HTML before the browser parses it. The harness cannot sign in as the owner of someone's private repo.
- `facebook-comment-injection.spec.ts` and `facebook-group-row-injection.spec.ts` inject a captured Facebook DOM shape into a live post page. Facebook A/B-serves one shape per account/day and keeps the other behind a group login, so neither can be summoned on demand.
- `glyph-size.spec.ts` plants a stale glyph size into extension storage for one mechanism case. The bug it pins needs state carried between pages, which no single page visit produces.

| Suite | Folder / file | User state | How it runs |
| --- | --- | --- | --- |
| **Unauthenticated** | every `*.spec.ts` in this folder (see the file map below) | Logged **out** of the platforms (sign-in prompts dismissed, never used) | `@playwright/test` launches Chromium with the unpacked extension. Deterministic, CI-friendly. |
| **Site-authenticated** | `site-auth/` | Logged **in** to the platforms + Emojery | Drives your real Chrome via the Playwright Extension bridge. See `site-auth/README.md`. |

This file documents the **unauthenticated** suite. It runs against the public **staging** backend by default and loads `.output/chrome-mv3-staging` (via `E2E_EXTENSION_PATH` in `.env.e2e.example`). Build the staging extension first:

```bash
pnpm run build:staging       # -> .output/chrome-mv3-staging
pnpm run test:e2e            # full matrix (build:staging must have run first)
pnpm run test:e2e:ci         # signed-out placement + auth-click loop only
pnpm run test:e2e:hermetic   # the browser-free project; runs on every PR
# a single file or subset: pnpm exec playwright test -c e2e/playwright.config.ts persistence.spec.ts
# the extension-less selector probe (own config, no build needed):
#   pnpm exec playwright test -c e2e/selector-drift/playwright.config.ts
```

## Firefox runs (`E2E_BROWSER=firefox`)

The same suite runs in Playwright's Firefox: the firefox build is installed as a **temporary add-on** over the remote debugging protocol at launch (`lib/firefox-addon.ts` — Firefox has no `--load-extension`), with the `moz-extension://` UUID pinned by pref so extension URLs are deterministic.

```bash
pnpm run build:staging:firefox   # -> .output/firefox-mv2-staging
E2E_BROWSER=firefox pnpm run test:e2e   # (or set E2E_BROWSER in .env.e2e.local)
# one-time prereq: pnpm exec playwright install firefox
```

What it covers: every content-script surface — placement, picker DOM, theming, replace-native detection, private-page gate, message boundary. What it **cannot** cover (those specs skip, with the reason in the report): anything driving the extension's **own pages** — popup, auth.html, sign-in and therefore every authed flow. Playwright's juggler protocol neither navigates to nor tracks `moz-extension://` pages (verified: even a tab the background opens via `tabs.create` never appears in `context.pages()`). Also chromium-only: CDP perf budgets, coexistence (Chrome MV3 sources), background-context seeding (`firstServiceWorker` — Firefox MV2 has a background page Playwright can't reach). Popup/auth coverage on real Firefox stays with `pnpm run dev:firefox` (web-ext) by hand.

## File map

The **When CI runs it** column is the honest map of what a green pipeline has actually verified. A spec marked *manual only* needs credentials CI does not hold or an opt-in source list — running it is on you before a release.

| File | Covers | Needs the Emojery test account? | When CI runs it |
| --- | --- | --- | --- |
| `site-injection.spec.ts` | Per-site placement, replace-native, localized placement, and the gated authed loop. Its scenario table is data-only in **`supported-sites.ts`**. | Only the authed loop | Every other day (`e2e-ci.yml`); the replace-native loop weekly; the GitHub + YouTube placement pair again in real Edge every other day (`edge-smoke.yml`) |
| `theme-contrast.spec.ts` | Trigger blending + WCAG contrast on real sites, light and dark | Only the active-state pass | Weekly, own job (`e2e-ci.yml`) |
| `glyph-size.spec.ts` | The trigger emoji is sized like the icons of the row it sits in, per site — plus the stale-size cases the per-site loop cannot produce | No | Manual only |
| `overlay-freeze.spec.ts` | Threads' URL-addressed photo lightbox: a `/media` overlay open/close cycle (pushState/back, no real click needed) must leave the mounts untouched — no blink, no stale wrong-post trigger | No | Manual only |
| `facebook-comment-injection.spec.ts` | A comment's reaction cluster never becomes a mount: injects the vulnerable A/B-served comment shape next to a live post's own counts row and asserts nothing mounts on or inside it | No | Manual only |
| `facebook-group-row-injection.spec.ts` | The icon-only Comment/Send action row (the group photo-post shape, which live sits behind a group login) still mounts a trigger: injects the captured row beside a live public post | No | Manual only |
| `auth.spec.ts` | The OTP login flow: rejected address, wrong code, cooldown, sign-in/out, localized errors | Yes | Manual only |
| `accounts.spec.ts` | Multi-account: identity isolation across switches, independent counter moves, email recovery, repeated wrong codes surfacing an error (all on GitHub) | Yes | Manual only |
| `authed-extras.spec.ts` | Master toggle, react/un-react counter math, offline queue flush, account deletion, the Report tab, rapid reaction switching, an in-flight vote surviving a reload, the analytics-consent default | Yes | Manual only |
| `reaction-burst.spec.ts` | A fast burst of reactions: every accepted click is counted and listed in History; a refused one is re-sent by the durable queue, losing nothing | Yes | Manual only |
| `persistence.spec.ts` | Settings and reactions surviving a full browser restart; a fresh profile starts from defaults | Yes | Manual only |
| `history-pagination.spec.ts` | Popup History paging + background IndexedDB search over a seeded 10k-row account | Yes | Manual only |
| `settings-extras.spec.ts` | The "Reaction animations" toggle, a second open popup not live-syncing a settings change (characterized), the popup reopening on the tab it was left on, and per-site off restoring the native control replace-native hid | Yes | Manual only |
| `layout.spec.ts` | The open picker popover staying on-screen under a ~400px window and 50% / 200% zoom | Yes | Manual only |
| `onboarding.spec.ts` | Fresh-install onboarding on a throwaway profile per test: the onboarding tab + toolbar dot and their restart behavior, the Try-it-live deep link auto-opening the picker, the one-shot coach-mark, and the first-reaction journey that retires the dot | Only the gate sign-in leg | Manual only |
| `a11y.spec.ts` | Accessibility of all three extension pages — popup, auth, onboarding (axe, aria snapshots, keyboard walk, reflow, text spacing) — `pnpm test:a11y` | Partly | Every other day (`a11y.yml`) |
| `private-pages.spec.ts` | The `isPrivatePage` gate, as an A/B pair on one public URL with the visibility marker rewritten | No | Every other day (`e2e-ci.yml`) |
| `coexistence.spec.ts` | Mounting next to other content-manipulating extensions. Needs `E2E_COEXT_SOURCES`; skips (and downloads nothing) without it | No | Manual only |
| `coext-source.spec.ts` | Pure self-check of `lib/coext-source` (source classification, crx→zip slicing). No browser, no network — its own zero-retry `hermetic` project | No | **Every PR** (`ci.yml`) + `pnpm check` |
| `message-boundary.spec.ts` | That no web page can reach the service worker at all — the regression a broad `externally_connectable` would be | No | Every other day (`e2e-ci.yml`) |
| `perf.spec.ts` | 2 budgets: renderer heap across a deep-scrolled feed (opt-in), and the style/layout work the extension itself causes. See [Perf budgets](#perf-budgets) | No | Heap only, weekly (`e2e-ci.yml` runs `-g "heap budget"`); the style/layout budget is manual |
| `selector-drift/selector-drift.spec.ts` | Extension-less probe: does every scenario URL still serve the native controls and containers the adapters anchor on? Nothing is built or loaded, so a red run names the dead selector group hours before the placement sweep sees it | No | Daily, own workflow (`selector-drift.yml`) |

`supported-sites.ts` and `lib/` are helpers, not suites. Everything in this folder — every spec, the helpers, and `site-auth/` under its own tsconfig — is type-checked by `pnpm compile:e2e`; neither Playwright's nor Vitest's esbuild transpile checks anything.

The helpers are layered, lowest first, so a spec is a table of scenarios plus the flow between them. Every module in `lib/` is listed:

| Module | What it owns |
| --- | --- |
| `lib/load-env.ts` · `lib/test-config.ts` | The ordered `.env` file set both e2e configs read, and reading it back: fixture URLs, test credentials, the glyphs the authed flows react with |
| `lib/launch-args.ts` · `lib/browser-session.ts` | The Chrome command line every extension-loading run needs, and the launch/teardown around it — which build, which profile dir, who deletes it |
| `lib/shared-session.ts` | `sharedSession()`: one browser per spec file, with the `beforeAll`/`afterAll` pair wired in one place so a half-copied teardown cannot leak a headed Chromium |
| `lib/firefox-addon.ts` | The `E2E_BROWSER=firefox` seam: installing the unpacked build as a temporary add-on over the Firefox remote debugging protocol, with the `moz-extension://` UUID pinned by pref |
| `lib/browser-reaper.ts` | The global setup/teardown that reaps phantom browsers a SIGKILL'd runner left holding a `.playwright/` profile |
| `lib/probe-src.ts` · `lib/selectors.ts` | The canonical shadow-piercing walk and the selectors, as source strings a `page.evaluate` body can interpolate |
| `lib/site-evidence.ts` | The shapes the suites pass around (`SupportedSiteScenario`, `MountEvidence`) |
| `lib/site-walls.ts` · `lib/page-settle.ts` · `lib/reload-settle.ts` | Getting a live third-party page into a state worth asserting on, turning it into one evidence record, and the fixed beat a post-reload remount needs (it exposes no event to await) |
| `lib/picker-probes.ts` | Reading and clicking the injected picker on that page |
| `lib/reaction-actions.ts` · `lib/reaction-surface.ts` | One target, one reaction: pick, clear, assert what came back — and the single-target live surfaces (GitHub, GitLab) the autonomous specs read it through |
| `lib/mount-wait.ts` | The gate the 2 Facebook injection specs share: the page's own post must mount before a synthetic row is injected, and a page that never mounts is a wall (skip), not a regression |
| `lib/extension-pages.ts` · `lib/popup-probes.ts` · `lib/popup-settings.ts` | The extension's own `chrome-extension://` surfaces — resolving its id, opening the popup, the History tab, driving the Settings/Account toggles to a target state |
| `lib/auth-signin.ts` | Driving `auth.html` through the request-code / verify exchange, with the retries a live backend needs |
| `lib/site-session.ts` · `lib/localized-placement.ts` | The browser session and skip diagnostics; the other-language placement check |
| `lib/coext-source.ts` | Resolving a coexistence-test extension source (folder, zip/crx URL, Web Store id) to a cached unpacked folder |
| `lib/extension.ts` | Barrel for the autonomous specs, kept for import stability — it re-exports the modules above under one path and owns no work of its own. New code imports the specific module. |

`lib/launch-args.ts` and `lib/auth-signin.ts` are deliberate leaf modules: the store-asset generator loads both directly under plain Node, so they import nothing but `node:*` and `@playwright/test`. A flag or a selector added for the suites reaches the release captures for free.

`selector-drift/` is the one suite the main config does not run: it carries its own `playwright.config.ts` and the main one lists it under `testIgnore`, so `pnpm run test:e2e` never picks it up. Run it directly — no build, no auth, ~5 minutes:

```bash
pnpm exec playwright test -c e2e/selector-drift/playwright.config.ts
```

Its CI job persists a per-scenario skip counter across runs (`scripts/track-selector-drift-skips.mjs`), because a URL that walls the probe every single day has gone silently blind and one run can't tell.

### Reddit is not covered here

Reddit hard-blocks datacenter IPs: on a GitHub-hosted runner every `reddit.com` URL answers "You've been blocked by network security", so all 3 Reddit scenarios skip in this job **and** in the placement sweep (`e2e-ci.yml`). Nothing in the repo can lift that — it is the runner's IP, not a fixture or a selector. A `macos-latest` runner sits on other infrastructure and was measured too (2026-08-26): same 3 skips, so no runner label buys this back. `selector-drift.yml` therefore declares them (`E2E_DRIFT_KNOWN_BLOCKED: "reddit:"`): the tracker prints them as an uncovered gap rather than failing on an unfixable block, and tells us to drop the entry the day a run gets through.

So Reddit's selectors are ours to check, off a CI IP — from any ordinary connection it takes half a minute:

```bash
pnpm exec playwright test -c e2e/selector-drift/playwright.config.ts -g reddit
```

Worth running before a release and whenever a Reddit placement bug is reported. The `site-auth/` bridge suite covers Reddit the same way, on your own browser and IP.

> A separate, non-e2e tier (WebKit + Firefox component tests, `pnpm run test:browser`) lives in `src/`, not here. See [Engine component tests (not e2e)](#engine-component-tests-not-e2e) at the end of this file.

## Authed gap specs, autonomous (GitHub + popup)

Every spec marked "Yes" above covers the gaps the site loops don't, **autonomously** — all on GitHub (the picker mounts there with no platform login, so no anti-bot exposure) plus the extension's own popup. They sign into an Emojery account, so they need `E2E_AUTH_EMAIL` + `E2E_AUTH_OTP` (see `.env.e2e.example`); without them the authed cases `test.skip`. Shared helpers live in `lib/extension.ts`.

- **`authed-extras.spec.ts`** — the popup and account gaps:
  - the master `Enabled` toggle removes the picker and restores it;
  - reacting increments the aggregate counter, un-reacting decrements it;
  - an offline-queued reaction flushes on reconnect and persists after a reload;
  - deleting the account signs out;
  - the Report tab shows the unsupported-page notice off a supported site, and submits a report on a supported page (the popup opens as a background tab, so the active tab stays a supported site and the form renders);
  - rapid back-to-back reaction switches settle on the last pick without corrupting the counter;
  - a vote still in flight survives a reload;
  - the analytics-consent toggle is authed-only and defaults ON.
- **`reaction-burst.spec.ts`** — reacting fast must not lose reactions ("I placed a lot of reactions quickly and not all of them were counted"). Clicks go through the real picker; the accounting is read from the vote responses and the popup, never from storage.
  - One case bursts across 2 targets (GitHub + GitLab): every click must be counted on the wire and appear as its own History row, right emoji, right target, newest first.
  - The other keeps clicking until a refusal comes back. Nothing extra may be counted while it does, and the durable queue must re-send every refused click afterwards, so History still holds exactly 1 row per click.
- **`persistence.spec.ts`** — changed settings survive a full browser restart; a reaction made before a restart is still the user's reaction afterwards (re-login: `--load-extension` clears the session each launch, unlike a store install); a fresh profile starts from defaults.

The login flow itself (rejected address, wrong code, cooldown, sign-in/out, localized errors) is in `auth.spec.ts`; history round-trip, emoji search (incl. localized queries), per-site toggle, replace-native, cross-tab and react/un-react are already covered by the gated authed loop in `site-injection.spec.ts`.

## What the unauthenticated suite covers (every supported site)

For **every site registered in `SUPPORTED_SITES`** (`SUPPORTED_SITE_SCENARIOS` in `supported-sites.ts`, several sites have >1 scenario). A new site ships its scenario(s) in the same PR (docs/adding-a-site.md step 9) — and `src/shared/e2e-site-coverage.test.ts` fails `pnpm test` if it doesn't, so this coverage can't fall behind the registry:

- **`extension is loaded`** — the unpacked build is present and `auth.html` renders.
- **`... default unauth placement and auth-click`** (always-on, per scenario) — the state a real default visitor gets (`replaceNative=false`, no platform login, no Emojery sign-in):
  - a matching `data-khasky-emojery-mounted` target key exists and at least 1 matching `.khasky-emojery-host` trigger is **visible**;
  - placement is near the native action / inside the expected container;
  - **no duplicate** target key across connected anchors (stolen-host invariant);
  - single-target scenarios don't render more hosts than expected;
  - clicking the **visible** trigger opens the in-picker sign-in gate, and the gate's "Sign in & react" button opens `auth.html` (proves it's really interactive), without signing in.
- **`... replaces native buttons after popup toggle`** (always-on, per scenario) — with "Hide original buttons" on, a host still renders and a native control is hidden (`data-khasky-emojery-hidden="1"`). **Exception:** a scenario carrying `expectHiddenNativeOnReplace: false` (Amazon CA) skips the hidden-native assert, the `replacedNativeInvisibleSelectors` check and the restore-after-off leg — for that scenario this case is a placement re-run only, so replacement there is covered by Amazon US, not by this title.
- **`... handles auth, reaction history, and per-site toggle`** (per scenario, **gated** on `E2E_AUTH_EMAIL` + `E2E_AUTH_OTP`) — signs into Emojery via OTP, reacts, sees it in History, then per-site toggle removes the host. This is the only loop that needs the extension's own account; it's skipped without the OTP env.
- **`private window: ... opens auth.html`** — the unauth click works in a fresh incognito context too.
- **Localized placement** (`ru`/`de`/`ja`) for selected scenarios.

### Evidence on failure

`collectMountEvidence` attaches compact JSON to every assertion: mounted keys, host samples (rect/visibility/zero-size-ancestor), visible native counts, placement reason, plus visual-correctness signals — `duplicateMatchingKeys`, `maxHostNativeOverlapRatio`, `clippedMatchingCount`, `matchingInsideHiddenAncestorCount`, `roleTooltipVisibleCount`. (Only the duplicate-key signal is hard-asserted; the rest are diagnostics — the per-site `nativeSelectors` are too coarse to base a non-flaky overlap/clipping assert on.)

## Theme & contrast

`theme-contrast.spec.ts` — black-box on real sites (no fixtures): the trigger blends into each site's action surface and stays legible (WCAG contrast), in light **and** dark. The idle-state check runs unauthenticated; the post-reaction (active) state is also measured when the test account is configured (`E2E_AUTH_EMAIL` / `E2E_AUTH_OTP`), since a reaction only sticks for a signed-in user.

`glyph-size.spec.ts` — the other half of blending: **size**. `site-injection` proves the host mounted next to the native action and `theme-contrast` proves it is legible; both pass just as happily with an emoji twice the size of its neighbours, which is what shipped when a remembered per-site glyph height outranked a row's own measurement. Per scenario it compares the size the trigger inherited against the icons the site itself draws inside that scenario's `nativeSelectors`; everything is relative, so a restyle moves both numbers together. 2 extra cases cover what one page cannot show: a **planted** stale size in extension storage that the trigger must ignore (deterministic), and the YouTube **surface order** a user walks, Shorts→watch and watch→Shorts in one profile (only fails on a day when the two surfaces really draw different icons — verified: against the pre-fix build the planted case failed every attempt while the ordered pair passed on retry).

## Perf budgets

`perf.spec.ts` holds 2 independent budgets.

**Heap** — a deep-scrolled feed: Reddit first, then X, Instagram, YouTube, and the case skips only when all 4 are walled. Opt-in behind `E2E_PERF=1`, because the limit is calibrated for the nightly CI machine. Long tasks are attached as evidence, never asserted.

**Style/layout** — the style recalculations and layouts the extension itself causes around one mounted trigger on GitHub, told apart from the page's own by the JS stack behind each trace event. Always on: attribution makes the number machine-independent, which a whole-renderer delta is not.

## Which browser runs, and the env knobs

Bundled Chromium by default (stable unpacked-extension loading), realistic-client mode on. `.env.e2e.example` carries the fixture URLs and the everyday knobs; the ones worth knowing:

- `E2E_CHROME_CHANNEL=chrome|msedge` — swaps the bundled Chromium for an installed channel. `msedge` is not just a local diagnostic: `edge-smoke.yml` runs the GitHub + YouTube placement scenarios in real Edge on its own schedule, so a red Edge smoke means Edge dropped the `--load-extension` path or the extension broke on Edge specifically.
- `E2E_USER_DATA_DIR` — reuse a dedicated warmed profile (never your personal one).
- `E2E_URL_<SITE>` — override a stale public test URL.
- `E2E_KEEP_OPEN_MS`, `E2E_KEEP_PROFILE` — keep the browser/profile after a run.
- `E2E_RETRIES` — live-flake retry budget, 2 by default; set it to `0` to reproduce a failure raw (that also switches tracing to `retain-on-failure`). Not in `.env.e2e.example`.
- `E2E_PERF=1` — opt in to the heap-budget run; `E2E_PERF_HEAP_LIMIT_MB` and `E2E_PERF_SCROLL_STEPS` retune it for a machine that isn't nightly CI, `E2E_PERF_METRICS_FILE` writes the measurements to a file.
- `E2E_BURST_ROUNDS`, `E2E_BURST_ROUND_MS`, `E2E_BURST_MAX_CLICKS`, `E2E_BURST_CLEAN_GITHUB`, `E2E_BURST_CLEAN_GITLAB` — shape of the `reaction-burst.spec.ts` runs: how many rounds and how long each one is, the click cap that makes a round that never gets refused fail loudly instead of clicking forever, and the click counts of the clean burst.
- `E2E_MIN_CONTRAST`, `E2E_FG_TOLERANCE` — the minimum contrast ratio `theme-contrast.spec.ts` holds the trigger to, and the per-channel tolerance when checking that the trigger color tracks the sampled site foreground.
- `E2E_GLYPH_SETTLE_MS` [13s] — how long `glyph-size.spec.ts` lets a trigger's size stop moving before judging it. The size is allowed to converge (a late-hydrating row paints a stand-in first); the spec asserts where it lands.
- `E2E_*_TEST_TIMEOUT_MS` (`E2E_DELETE_`, `E2E_WRONG_CODE_`, `E2E_TWO_ACCOUNT_`, `E2E_BURST_`, `E2E_REFUSED_BURST_`, `E2E_COEXT_`, `E2E_I18N_`, `E2E_INTRO_`) plus `E2E_AUTHED_SITE_TIMEOUT_MS` — per-case budgets for the long authed flows.

What a run is pointed at, all with a checked-in default in `.env.e2e.example`:

| Knob | Selects |
| --- | --- |
| `E2E_API_BASE` | The origin the build under test talks to; `auth.spec.ts` fails loudly rather than guessing when neither it nor `WXT_API_BASE` is set. |
| `E2E_EXTENSION_PATH` [`.output/chrome-mv3-staging`] · `E2E_FIREFOX_EXTENSION_PATH` [`.output/firefox-mv2-staging`] | Which build a run loads, per browser. |
| `E2E_BROWSER_EXECUTABLE_PATH` | An explicit browser binary instead of the bundled one (`E2E_CHROME_CHANNEL` is the by-channel form). |
| `E2E_ENV_FILE` | One extra dotenv file, loaded after the standard set. |
| `E2E_LOCALE` [`en-US`] · `E2E_TIMEZONE_ID` [the machine's] · `E2E_USER_AGENT` [the browser's own] | The client identity every context is created with. An unset `E2E_USER_AGENT` omits the key rather than sending an empty one. |
| `E2E_REALISTIC_CLIENT` [on; `0` disables] | The realistic-client launch flags that keep live sites from serving an automation shape. |
| `E2E_VIDEO=1` | Record video, retained on failure. Off by default. |
| `E2E_REJECTED_EMAIL` · `E2E_WRONG_CODE_ATTEMPTS` | The auth error-path fixtures: the address the rejection leg signs in with, and the wrong-code budget the repeated-wrong-code check needs (that case skips until it is set). |

The rest are waits and per-spec knobs that only matter on a slow machine or when you are debugging one spec; each falls back to the default in brackets:

| Knob | Tunes |
| --- | --- |
| `E2E_TEST_TIMEOUT_MS` [120s] · `E2E_EXPECT_TIMEOUT_MS` [30s] | The whole-test and single-`expect` budgets, set on the Playwright config. |
| `E2E_DEFAULT_TIMEOUT_MS` [30s] · `E2E_NAV_TIMEOUT_MS` [60s] | The per-action and per-navigation budgets every launched context starts with. |
| `E2E_SITE_TIMEOUT_MS` [70s] | How long a live third-party page gets to settle and mount before the probe gives up on it. |
| `E2E_STEP_DELAY_MS` [0] | A pause between the steps of `site-injection.spec.ts`, for watching a run rather than passing it. |
| `E2E_VOTE_FLUSH_MS` [5s] | How long a spec waits for the queue to flush before reading the result. |
| `E2E_COUNT_CACHE_WAIT_MS` [210s] | The wait for an updated public count in the specs that assert one. |
| `E2E_HISTORY_TARGET_TIMEOUT_MS` [30s] · `E2E_HISTORY_REACTION_TIMEOUT_MS` [20s] | Waiting for a target's row, and for the reaction on it, to appear in popup History. The first is named for that wait but budgets **every** visible-trigger wait in the suite (`lib/picker-probes.ts`), reaction picks included. |
| `E2E_PRIVATE_SETTLE_MS` [7s] · `E2E_PRIVATE_MOUNT_TIMEOUT_MS` [25s] | `private-pages.spec.ts`: page settle and mount budget for the `isPrivatePage` A/B pair. |
| `E2E_ACTIVE_STATE_TIMEOUT_MS` [45s] | `theme-contrast.spec.ts`: how long the active-state probe waits for the pressed trigger styling. |
| `E2E_OVERLAY_MOUNT_TIMEOUT_MS` [25s] | `overlay-freeze.spec.ts`: mount budget before the overlay-freeze scenario starts. |
| `E2E_FB_INJECT_MOUNT_TIMEOUT_MS` [30s] · `E2E_FB_INJECT_SETTLE_MS` [8s / 12s] | The 2 Facebook injection specs (`facebook-comment-injection`, `facebook-group-row-injection`): mount budget and post-injection settle (the group-row spec settles 12s). |
| `E2E_COEXT_PATH` | A single local coexistence-extension folder; merged with `E2E_COEXT_SOURCES` / `E2E_COEXT_PATHS`. |

That is every `E2E_*` the specs and helpers in this folder read. 2 more layers carry their own:

- **The site-authenticated suite** — `E2E_SITEAUTH`, `E2E_MCP_URL`, `E2E_AUTHURL_<SITE>`, `E2E_WARMUP_FACEBOOK_GROUP`, `E2E_DEEP_SCROLL_STEPS`, `E2E_DEEP_SCROLL_HEAP_LIMIT_MB`, `E2E_FB_COMMENT_HYDRATE_MS`, `E2E_WALL_SCROLL_STEPS`, documented in [site-auth/README.md](site-auth/README.md).
- **The CI gate scripts**, which read a Playwright JSON report rather than running a spec: `E2E_MAX_SKIP_RATIO` [0.5] fails a sweep whose skipped share crosses it (`scripts/check-e2e-skips.mjs`, the "Gate on skip ratio" step in `e2e-ci.yml` and `edge-smoke.yml`), and `E2E_DRIFT_MAX_CONSECUTIVE_SKIPS` [5] fails the drift probe when one scenario URL has walled it that many runs in a row (`scripts/track-selector-drift-skips.mjs`), with `E2E_DRIFT_KNOWN_BLOCKED` [``] listing the scenario-title prefixes that runner cannot reach at all (see [Reddit is not covered here](#reddit-is-not-covered-here)).

After adding one, re-derive the full set with `git grep -ho "E2E_[A-Z0-9_]*" e2e/ scripts/ | sort -u` and document it in the matching list above or in `.env.e2e.example`.

### Headed only, and why headless is not a shortcut

Every launcher here passes `headless: false`, and CI runs the same way under `xvfb`.

Flipping the flag does not give you a headless suite: with no `channel` set, Playwright resolves `headless: true` to the `chromium-headless-shell` binary, which has no extension system — `--load-extension` is ignored, no service worker starts, and every spec that resolves the extension id dies on a null. The pair that does load the extension is `channel: "chromium"` together with `headless: true` (the full Chromium build, launched with `--headless`).

Two reasons it is still not the default:

- **The client identity changes.** New headless reports `HeadlessChrome/...` in its User-Agent — the automation shape logged-out social and commerce sites gate on. That does not turn tests red, it turns them into `test.skip`, and a skip is green: the run reads healthier while verifying less. `E2E_USER_AGENT` reaches only the live-site launcher (`lib/site-session.ts`), not `launchSession()`, and overriding the UA string leaves `Sec-CH-UA` saying the same thing.
- **It buys no wall time.** A run's cost is live pages over the network; the launch difference between the two modes is a rounding error next to a single site settling.

What headless would genuinely buy is a run that neither steals window focus nor drives the GPU. Unverified either way: whether `theme-contrast` and `glyph-size` land on the same numbers without a compositor. The hover media queries, at least, resolve identically in both modes.

## Known caveat: logged-out social sites can be bot-blocked

Logged-out **social** sites (Facebook/Instagram/X/Reddit/Threads) gate or bot-challenge automated browsers, so their live unauth runs can be flaky or blocked in some environments (Reddit network blocks, X login wall). The login-free sites (GitHub, GitLab, Amazon, YouTube) run reliably. This is an environment/anti-bot limitation, not an extension bug; re-run or use a dedicated `E2E_USER_DATA_DIR`. Deterministic logged-in coverage lives in `site-auth/`.

## Engine component tests (not e2e)

A separate, **non-e2e** tier lives next to the source in `src/` (not in this folder): `src/**/*.browser.test.{ts,tsx}`, run with `pnpm run test:browser`. Despite also using Playwright, it is a different layer:

- **Runner:** Vitest browser mode (`vitest.browser.config.ts`), not `@playwright/test` — Playwright only supplies the browser; the tests use the Vitest API.
- **Engine:** real **WebKit** (the closest cross-platform proxy for Safari's engine, runnable on Windows/Linux/macOS without a Mac) and real **Firefox** (Gecko).
- **Subject:** the picker UI rendered from source (`picker.tsx`) against an in-memory `chrome` shim (`src/test/chrome-shim.ts`) — it catches engine-specific rendering / CSS / shadow-DOM / JS regressions that jsdom can't see.

It is **not** a Safari or Firefox extension e2e: no packaged build, no background context, no real `chrome.*` APIs, no permission prompts — a real Safari pass (macOS only) stays the release gate for the Safari build, and the Firefox extension tier is the `E2E_BROWSER=firefox` run above. These tests stay in `src/`, co-located with the code like the other `*.test.ts`; this folder is reserved for black-box, real-extension, live-site runs.
