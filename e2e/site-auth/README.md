# Site-authenticated e2e (Playwright Extension bridge)

Black-box checks of Emojery for users logged into the host platforms (Facebook, Instagram, Reddit, X, Threads, ...) and into Emojery (OTP). It drives your real, human-launched Chrome through the Playwright Extension (`@playwright/mcp --extension` -> `chrome.debugger`) instead of launching its own browser the way the `test:e2e` runner does. That is what makes a logged-in run possible at all: the session is the one you already have, and it stays where you left it.

> **Warning — `test:e2e:siteauth:autopress` acts as you, in public.** It exercises the **Auto-press original buttons** setting, so it presses real native controls under your signed-in accounts:
>
> - YouTube — a Like and a Dislike (anonymous, but they move a public count).
> - Reddit — a downvote (same: anonymous, public count).
> - Facebook — a ❤️ Love reaction, through the hover flyout.
> - GitHub — a repo star. GitLab — a project star.
> - Threads — a like. Instagram — a like.
>
> Each press is reverted before the flow ends. While it runs, the GitHub and GitLab stars, the Threads and Instagram likes, and the Facebook reaction are attributed to your account and visible to others, and the author's star/like notification can land before the revert does. Run this flow only from an account you are willing to do that with.

Every other scenario is passive: navigate, click the Emojery trigger, read the DOM. An Emojery reaction writes only to the Emojery backend under your Emojery account and performs no platform-side action — the Emojery trigger is not the native Like. Personal accounts are fine.

## One-time setup

1. `pnpm run build:staging` → `.output/chrome-mv3-staging` — the build this suite drives.
2. In Chrome (not Brave): install the Playwright Extension (Web Store) and **Load unpacked** the Emojery build above (`chrome://extensions` → **Developer mode**).
3. In that Chrome, log into the platforms, then sign Emojery in through its own popup. The sign-in is manual, because the bridge attaches to a single tab and can't open `chrome-extension://` pages. Which account the suite expects is resolved by `e2e/lib/test-config.ts`; the keys it reads are listed in `.env.e2e.example`.
4. Copy the token from the Playwright Extension popup (per browser profile).

> **Fail-fast:** the suite does not silently skip when a login is missing. If the bridge can't attach, Emojery is signed out, or a site being exercised isn't logged in, the run fails immediately with an actionable message telling you what to log into.
>
> **Leave the driven tab in front.** Emojery runs no scan while `document.hidden` and catches up on the next `visibilitychange`, so a tab Chrome considers hidden mounts nothing — on every site at once. The run opens its own tab and re-activates it before each navigation; what still backgrounds it, measured on Windows 10 / Chrome 152:
>
> | Window state | `document.hidden` |
> | --- | --- |
> | Unfocused, another app or monitor in front, window visible | `false` — the run is fine |
> | Fully covered by another window, Chrome started with `--disable-backgrounding-occluded-windows` | `false` — the run is fine |
> | **Minimized** | `true` — every check goes zero-host |
> | **Another tab active in the same window** | `true` — same |
>
> So launch that Chrome as `chrome.exe --disable-backgrounding-occluded-windows` (all its windows closed first, else the switch is ignored), then just don't minimize the window or click another tab in it. Without the switch, a window another window fully covers is hidden too — Windows occlusion tracking marks its tabs hidden, and the `chrome://flags` entry that used to disable it is gone. A check that lands on a hidden tab now says so instead of blaming the site login.
>
> The run also leaves one `connect.html` relay tab per interrupted run — the bridge can only see its own tabs, so a killed run's tab has to be closed by hand.

## Run

Keep that Chrome running, then — PowerShell:

```powershell
$env:E2E_SITEAUTH = "1"
$env:PLAYWRIGHT_MCP_EXTENSION_TOKEN = "<token from the Playwright Extension popup>"
pnpm run test:e2e:siteauth
```

bash / zsh:

```bash
export E2E_SITEAUTH=1
export PLAYWRIGHT_MCP_EXTENSION_TOKEN="<token from the Playwright Extension popup>"
pnpm run test:e2e:siteauth
```

### One flow needs a popup toggle, so it runs on its own

The bridge cannot open `chrome-extension://` pages, so it can neither read nor change the extension's settings — you set them by hand in the popup. Only the auto-press flow needs a non-default one, so only it is split out:

| Command | Popup settings it assumes |
| --- | --- |
| `pnpm run test:e2e:siteauth` | stock defaults (everything except auto-press) |
| `pnpm run test:e2e:siteauth:autopress` | **Auto-press original buttons** on |

The main command excludes the auto-press file rather than listing the others, so a new flow that runs on defaults joins it automatically.

`:autopress` tells the 2 failure kinds apart: while no site has pressed yet, a failure says the setting is probably off; once any site has pressed, the setting is proven on and later failures name the specific site instead — so a broken site is never mistaken for a setup mistake.

Run the precheck first (the connection spike) to catch setup mistakes early — it is the first file of the main run anyway, but on its own it answers in ~10 s:

```bash
pnpm exec vitest run -c e2e/site-auth/vitest.config.ts precheck
```

- OK: precheck green → bridge attached to your real Chrome + Emojery is signed in.
- FAIL: "bridge launched a throwaway browser" → the token/extension is wrong; the server didn't attach (your real tabs should be visible, not one `about:blank`).
- FAIL: "Emojery picker grid did not open" → finish the Emojery OTP in that Chrome.
- FAIL: "Emojery is SIGNED OUT" → the Emojery popup in that Chrome is signed out. Sign in there by hand and re-run.
- FAIL: "pointed at the WRONG BUILD" → the loaded build is not the one this suite drives. Rebuild with `pnpm run build:staging` and load `.output/chrome-mv3-staging` unpacked ("Emojery (Staging)" on `chrome://extensions`).

Connecting to an already-running server instead of the in-process one — start it in a separate terminal, passing the 2 flags the in-process bridge sets for itself (see `E2E_MCP_SETTLE_MS` below; without them every round-trip costs ~0.5–1 s instead of ~8 ms):

```bash
npx @playwright/mcp@latest --extension --port 8931 --snapshot-mode none --timeout-settle 0
```

Then point the run at it. PowerShell:

```powershell
$env:E2E_MCP_URL = "http://localhost:8931/mcp"
```

bash / zsh:

```bash
export E2E_MCP_URL="http://localhost:8931/mcp"
```

## Account state: warmed up automatically (no manual setup)

You only need to be logged in (to the platforms + Emojery). The `lifecycle` flow provisions the non-default state it wants at the start of the run and restores it to its prior value afterward — nothing you had before a run is left changed (see `warmup.ts`). Each warm-up is best-effort and verification-gated: if it can't drive a site's UI (markup drift / non-English account UI) it logs and leaves the account untouched, and the structural checks then run against whatever state the account is in.

- **Dark rendering** — the run emulates a dark client color-scheme, so sites that follow the system/device theme (the logged-in default) render dark while the structural checks run; the emulation is reset at the end. An account pinned to an explicit light theme stays light — that account's own theme is what a run then exercises. Light + `prefers-color-scheme` are also covered logged-out by `theme-contrast.spec.ts`.
- **Threads: hide like & share counts** — turned on for the run (a different action-row layout the counts-visible logged-out suite doesn't reach), then restored to its prior value. Only an English account UI is auto-detected.
- **Facebook group membership** — only when you point `E2E_WARMUP_FACEBOOK_GROUP` at a specific group: the run joins it (if not already a member) so the group-feed check has posts, then leaves it afterward. Without that variable nothing is joined and the group-feed check skips when the account is in no active group (or point `E2E_AUTHURL_FACEBOOK_GROUP` at a group whose feed you're already a member of). A group needing admin approval won't grant membership in time (the check skips); the pending request is cancelled on teardown.
- **Instagram carousel** — point `E2E_AUTHURL_INSTAGRAM_CAROUSEL` at a stable multi-image post; the carousel check skips without it (there is no account setting to toggle here: it's content).

A revert that fails is logged loudly (`[warmup] <id>: revert FAILED`) so you can restore that one setting by hand.

Each confirmed change to real account state is journaled to `.playwright/warmup-journal.json` before the run continues, so a process that dies between apply and restore doesn't strand it: the next run reads the journal and replays those reverts first. That file is the only record a crashed run leaves — don't delete it while a warm-up is outstanding.

## Coverage requirement: all 9 supported sites

Every supported content-script site is exercised on each run — no sampling, no subset:

Facebook, Instagram, Reddit, Threads, X, YouTube, GitHub, GitLab, Amazon

- The `reaction-roundtrip` flow runs on all 9 sites (the per-site baseline: react → emoji+count → persists after reload).
- The `lifecycle` flow additionally goes deep on the feed-heavy / bot-sensitive sites (`DEEP_SITES`: Facebook, Instagram, Reddit, Threads, X). The `localized` flow is Facebook-only, and opportunistic (it skips unless that account's UI renders RU/UA).

A site whose live session or content isn't present in the connected Chrome makes the run fail fast (not skip), with a message naming what to log into. Fix it (log in to that site / refresh the URL) and re-run; a missing site is never a pass.

The tier lists in `scenarios.ts` can't fall behind the site registry either: `SiteId` is `SupportedSite`, and `src/shared/e2e-site-coverage.test.ts` fails `pnpm test` until a new site lands in `DEEP_SITES` or `SMOKE_SITES` (the per-site URLs themselves live in the `E2E_AUTHURL_<SITE>` env fixtures, not in code).

## What each flow proves

| Flow file | Proves |
| --- | --- |
| `warmup` | Not a live flow: a browser-free, bridge-free self-check of the warm-up orchestration — only the steps that reported a change are undone, in LIFO order, and one failing undo doesn't stop the rest. The property the "restore after the run" guarantee rests on, so it runs in the same command. |
| `harness` | The other browser-free self-check: the 2 discriminations `waitForHost` has to get right. A page it cannot read at all is a broken bridge, and a readable page serving a recognized anti-bot wall is the environment — neither is a missing site login. Returning 0 for either once sent 8 tests' readers after a login that was never the problem. |
| `precheck` | Bridge is on the real Chrome; Emojery extension is signed in. |
| `reaction-roundtrip` (9 sites) | Real authenticated reaction shows emoji+count and persists across reload; cross-tab counter syncs via the SW-brokered push; picker search narrows the emoji grid on a live platform. |
| `lifecycle` (all 9; deep on FB/IG/Reddit/X/Threads) | Hosts mount with no duplicate target keys on every site, and the feed-heavy ones survive a deep scroll. See [What `lifecycle` checks](#what-lifecycle-checks). |
| `wall-coverage` | Post-by-post coverage of a Facebook profile wall and a group wall: every post whose action row has entered the viewport carries a visible, correctly placed trigger. A post is audited only after its Like control has sat well inside the viewport for a settle step, so lazy mounting below the fold is never misread as a missing trigger; one that never reports a placed host fails the run with its permalink. `lifecycle`'s scroll counts hosts in aggregate, which hides the post class that mounts nothing while its neighbours mount. |
| `comment-surface` | A Facebook permalink whose pinned top comment carries photo attachments mounts no trigger on a comment. The comment footer that mimics a post's counts row only renders for a signed-in, non-English account, so this shape cannot be reached logged out. Suggested posts under the permalink legitimately earn their own triggers, so the assert is "nothing mounts inside a comment", never a host count. |
| `localized` | Opportunistic: RU/UA FB feed still mounts (stem matching) without overlap — else skips (durable contract is in adapter unit tests). |
| `auto-press` (YouTube, Reddit, GitLab, GitHub, Threads, Instagram, Facebook) | The **Auto-press original buttons** setting: a pick presses the site's own control, un-react releases it. See [What `auto-press` presses](#what-auto-press-presses). |

### What `lifecycle` checks

- Every site mounts hosts with no duplicate target keys; a single-target site confirms exactly 1 host.
- The feed-heavy sites stay stable across a deep scroll (~50–100 posts): no dup keys accumulate, a trigger stays clickable, heap is logged.
- 2 distinct FB anchors never share a key. A single-photo post keys on its media id, `photo:<media>`, the one identity the feed card, the permalink and the photo viewer agree on — so photo-keyed anchors are expected, and the invariant is that a reshared photo doesn't merge 2 posts.
- No FB post carries 2 pickers. The page-admin "View insights / Boost post" row class produces different keys per host, so the dup-key checks miss it; it reproduces on the admin's own fresh post, so point `E2E_AUTHURL_FACEBOOK` at your page or group.
- FB date-hover doesn't flip the host or pop a tooltip.
- Reddit hosts return after a scroll up.
- A Threads reply preview mounts no picker — only the unit's main post may. Checked on `E2E_AUTHURL_THREADS_REPLIES` (a profile's replies tab, where every unit has that shape), not on the home feed: the feed carries that shape too rarely to rely on, so a feed-driven check skipped nearly every run.

### What `auto-press` presses

Not platform-passive, unlike every other flow: it presses real native controls under the signed-in account and reverts each press before finishing. **Which controls, on which sites, is the warning at the top of this file** — read that before running it. Turn **Auto-press original buttons** on in the Emojery popup first; the failure message reminds you.

What this section adds is how each press is then verified. A positive pick presses the site's affirmative control and a negative one its opposite, and un-react has to release exactly what was pressed — so the flow needs to READ the native pressed state. GitLab, GitHub, Threads and Instagram expose no generic one, so the check reads the star icon, the flipped Star label, the heart's paint or the localized heart label instead. Each of those cases injects the shipped reader out of `src/adapters`, which is what makes a drifted helper fail here rather than silently on a user's page.

## Fail-fast rules, media muting, and per-run URL overrides

- Setup reconnects once before failing (vitest's `retry` covers tests, never hooks, so a transient in the cold first-file connection used to kill a whole file with a bare "Hook timed out"); a signed-out extension is not retried.
- **The relay's tab is never the tab under test.** Each connection (1 per test file) opens a Playwright Extension `connect.html` tab in your Chrome, and with no tab selected in that extension the relay hands the bridge that same page to drive — navigating it tears the relay down, after which every call for the rest of the run stalls into the 30 s ceiling on every site, github and amazon included. So the bridge opens a tab of its own and works there, leaving the relay page alone.
- **Tabs the bridge opens, it closes.** Teardown closes 3 things: the tabs a flow opened itself, the bridge's own working tab, and every `connect.html` tab carrying this suite's MCP client name (so another Playwright client's bridge in the same browser is left alone). A run is tab-neutral; a killed run strands its 2, and the next connection sweeps the stale relay pages before it starts, keeping only its own.
- A stalled relay costs the work in flight, not the run: 2 calls in a row hitting the 30 s ceiling is the verdict, and the scroll walks stop after 2 lost reads rather than spending every remaining step at ~61 s. The connection is deliberately not replaced — a stall passes, and a fresh relay would abandon the tab this one is driving (already navigated onto a site, no longer tellable from the user's own), which is how a browser gets to OOM.
- The run fails fast (not skip) when the bridge can't attach, Emojery is signed out, or a site being exercised isn't logged in — the error names exactly what to log into. A missing/signed-out extension is remembered on first sight, so every remaining file aborts on it in milliseconds instead of re-running the ~25 s precondition check and burying the one real cause under identical stack traces. The remaining skips are conditional: the whole suite when `E2E_SITEAUTH` is off, the opportunistic RU/UA `localized` check, and the lifecycle checks whose optional content or account state is absent (the group feed, the Instagram carousel, the Threads reply previews — see the warm-up section above).
- YouTube and other video tabs are auto-paused and muted by the harness (`muteMedia`) so a watch page doesn't blast audio during a run.
- The round-trip picks an emoji the user has not already selected (picking a selected one toggles the reaction off — verified live), so persistence is deterministic across re-runs.
- The picker is opened on the first visible trigger with a forced click (`filter({ visible: true })` + `force`) — a coordinate click can land on an overlapping site element (verified live on a FB photo permalink, where the post photo overlaps the action-row region). On a FB photo-permalink layout the picker can still fail to open via automation; the FB round-trip is reliable on the home feed and a `/posts/` permalink (the live pass confirmed both pfbid-keyed and `fb:url`-fallback posts react correctly).
- Override any content URL per run: `E2E_AUTHURL_<SITE>` (e.g. `E2E_AUTHURL_REDDIT`), or `E2E_AUTHURL_<SITE>_DETAIL` for detail pages.
- The `lifecycle` deep scroll has 2 knobs: `E2E_DEEP_SCROLL_STEPS` [20] is how many scroll steps each deep site gets, and `E2E_DEEP_SCROLL_HEAP_LIMIT_MB` [600] is the renderer-heap growth allowed across that scroll — set it to `0` to log the number without asserting on it.
- `E2E_FB_COMMENT_HYDRATE_MS` [8s] is the pause `comment-surface` gives Facebook to hydrate the comment thread before probing it; `E2E_WALL_SCROLL_STEPS` [8] is how many 0.7-viewport scroll steps the `wall-coverage` flow walks down the wall.
- `E2E_MCP_SETTLE_MS` [0] is how long `@playwright/mcp` holds each reply waiting for the page's triggered work to quiet down. The bridge times its own waits, so its default is off; the stock 500 ms turns every one of the suite's thousands of round-trips from ~8 ms into ~0.5–1 s (measured per site over 12 no-op calls), and on a feed that never stops fetching it is an open ceiling rather than a floor — that setting plus the discarded per-call page snapshot is the whole difference between a run that finishes and one that does not. Raise it only if a page turns out to need the quiet.
- Sessions/token expire → re-export the token / re-login, then re-run.
- This suite is gated off by default (`E2E_SITEAUTH`) and never runs in `pnpm test` or the deterministic `test:e2e`.
