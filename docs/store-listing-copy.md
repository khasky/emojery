# Store Listing Copy (CWS / Edge / AMO)

## Extension Name

```text
Emojery
```

## Summary / Title

```text
Turn every Like button on the web into a full emoji palette.
```

## Description

```text
Emojery adds 600+ emoji reactions beside the Like, Star and vote buttons on supported websites. Go beyond the built-in reaction menu, choose a more specific response and see what other users selected.

HOW IT WORKS

Open a supported post, video, repository or product page to see the top 3 emoji and the total reaction count. Click the button for the full breakdown, a searchable emoji palette and your own reaction controls.

No account is needed to read counts. To add a reaction, sign in with an email code. These reactions are counted separately from the site's native Likes, stars and votes.

FEATURES

- 600+ emoji in 9 categories, with recently used choices one tap away.
- Emoji labels and search in 26 languages. Type amour, 愛 or love to find ❤️.
- A button that fits beside the site's existing controls and follows light or dark mode.
- Per-site settings to disable Emojery and keep or hide native buttons in your browser.
- Reactions that you can change or remove at any time.
- Local history with search, filters by site, emoji or date, and export for backup or restoration in another browser.
- Queued reactions that are retried after a connection drop, with count updates across your open tabs.
- Optional auto-press of the site's native reaction buttons, off by default, with customizable emoji mappings.

CHECK THE TOTALS

Accepted reactions are recorded in a public, tamper-evident log, with checkpoints anchored outside the service. A free, open-source verifier reconstructs the totals from that record.

Email verification and anti-abuse checks help limit spam. Reactions identified as abuse can be removed from the totals.

PRIVACY AND DATA

- The extension contains no ad code, third-party advertising trackers or analytics SDKs.
- Your email is used to send a sign-in code and then discarded. A one-way keyed hash remains as your account ID.
- Your browsable history stays on your device. To show counts, the extension sends the public identifiers of items on screen; the service answers without storing them. Submitted reactions and their public target identifiers are stored. Public log entries use pseudonyms.
- Community insights is enabled by default. It attaches country and city, language, browser and operating system to the reactions you submit, for aggregate statistics. Turn it off in Settings.
- Account deletion removes your reactions from the totals. Historical pseudonymous log entries remain, with reversals recording the change.

SUPPORTED SITES

Emojery currently supports 9 sites, including Facebook, Instagram, Reddit, YouTube and GitHub. Check https://emojery.app for the full list and supported content types.

Reactions are available on supported public content. Site support and fixes come through extension updates. You can request another site in the source repository.

ABOUT THE PROJECT

Emojery is free, donation-funded and open source under GPL-3.0. Built by one developer, it is currently in public beta.

Source code and site requests: https://github.com/khasky/emojery
Privacy policy: https://emojery.app/privacy

Emojery is an independent project. All product names, logos and trademarks are the property of their respective owners.
```

## Single purpose description

```text
Emojery lets people react to web content with a full emoji palette and see aggregate reaction counts contributed by email-verified users, shown inline next to the existing Like / Star / vote buttons on a fixed list of supported sites. Every permission and every host exists to render that one reaction control and sync its counts.
```

## storage justification

```text
Used to save extension settings, per-site preferences, the signed-in session (the session token and the email address it was opened with, kept only to label the account in the popup), a random installation identifier, recently used emoji, local reaction state and a 60-second cache of counts. Only the settings object syncs through the browser's extension-settings sync; the session, the identifier, the cache and the reaction state stay on the device. These values support the reaction picker, the account session and consistent behavior between visits.
```

## unlimitedStorage justification

```text
Used to retain the user's local reaction history in IndexedDB as it grows beyond default storage quotas and to protect it from automatic storage eviction. This supports history search, filtering, export and restoration. The browsable history database is not uploaded to Emojery's servers; submitted reactions are processed separately by the reaction service.
```

## alarms justification

```text
Used to schedule short background tasks that retry queued reactions after temporary connection failures and refresh cached reaction counts. This lets pending submissions resume without keeping the extension's background service worker continuously running.
```

## activeTab justification

```text
Used when the user opens the extension from the browser toolbar to inspect the active tab's URL, determine whether the current site is supported and display the appropriate site status and controls. Access is triggered by the user's action and is not used to monitor unrelated tabs or retrieve the browser's browsing-history database.
```

## scripting justification

```text
Used to inject the extension's packaged content scripts into already-open supported pages when the extension is installed, so the reaction interface appears without requiring a page reload. Injection is restricted to supported host patterns. The scripts add the reaction interface and run from files included in the submitted extension package.
```

## Host permission justification

```text
Access to the listed Facebook, Instagram, Reddit, YouTube, X, Threads, GitHub, GitLab and Amazon hosts is required to identify supported public content, insert the reaction interface and display its counts. User-enabled settings can hide native controls and link an emoji selection to a native reaction or vote on the current page; Auto-press is off by default. Access to api.emojery.app supports count lookups, email-code authentication, reaction submissions and removals, account deletion and user-submitted bug reports. Access to emojery.app lets a packaged script expose the installed version and handle reaction links. Content scripts run only on the declared supported hosts, not arbitrary websites.
```

## Homepage URL

```text
https://emojery.app
```

## Support URL / Support website

```text
https://emojery.app/contact
```

## Privacy policy URL

```text
https://emojery.app/privacy
```

## Support Email

```text
hello@emojery.app
```

## License

```text
GNU General Public License v3.0
```

## Privacy Policy

```text
Emojery collects the minimum needed to make a reaction count. Full policy: https://emojery.app/privacy (effective 10 September 2026).

WHAT LEAVES YOUR BROWSER

- To show counts, the public target keys of supported items that scroll into view, before you react. That lookup carries no account and no installation identifier, and the service answers it without storing or logging the keys. While you are signed in, a second request asks which of those items you have already reacted to; it carries your session token and is not stored either.
- The reactions you submit, with the canonical URL and the public identifier of the item you reacted to. The service keeps the identifier, not the URL.
- Your email address at sign-in, transiently: sent over TLS, used once to deliver a 6-digit code, then discarded on the server. What remains there as your account identifier is a one-way keyed hash of it. The extension keeps the address in its local storage to label the account, and sends it once more only if you delete the account.
- A session token and a random installation identifier that lasts as long as the installation. The identifier travels only on the requests you initiate that change something: signing in, submitting or removing a reaction, filing a report, deleting your account. Reading counts sends neither.
- A bug report, only when you send one from the Report tab: your note, the page it is about, and, while Community insights is on, the browser's user-agent string and the extension version.
- With the "Community insights" setting on, which it is unless you turn it off: country and city, language, browser family and OS alongside a reaction.

WHAT IS NEVER COLLECTED

Real names, email addresses stored on the server, hardware or high-entropy fingerprints, advertising cookies or tracking pixels, passwords, and any stored record of pages you did not react on. Raw IP addresses are never stored: the network layer sees your address the way any web server does, and what the service keeps is a daily-rotating salted hash used to limit abuse. The extension loads no analytics SDK.

STORAGE AND RETENTION

Sign-in code: 10 minutes or until used. Session token: 30 days, in extension storage. Account record and active reactions: until you delete them. Aggregate per-item counts: indefinitely. Public transparency-log entries: permanent and append-only, so a deletion is recorded as a public revocation rather than an erasure. A bug report you filed, and abuse decisions and linked-account reviews of the last 90 days, are kept after account deletion; the full table with every period is at https://emojery.app/privacy#retention.

WHERE YOUR REACTIONS LIVE

Your device keeps the browsable history, including page titles, in the browser's IndexedDB, and it is never uploaded. The service keeps your current reaction per item and the pseudonymous entries in the public log.

SUBPROCESSORS

Cloudflare (infrastructure, bot check, country/city), Neon (managed database, EU or US), Resend (delivery of the one-time code; the address is not retained), Axiom (backend logs, 30 days, no raw email, IP or user-agent), Discord (the maintainer's private alerts: abuse decisions, bug reports, uninstall-survey answers), DeepSeek (a language-model second opinion on anti-abuse findings; receives counts and public target keys only), rdap.org and Cloudflare DNS (the domain part of the sign-in address, to refuse throwaway domains). The public transparency log is published to GitHub, anchored through Sigstore Rekor and the OpenTimestamps calendars, and archived by Software Heritage; the entries it carries are pseudonymous. Changes to this list are dated at https://emojery.app/privacy#subprocessor-changes.

YOUR RIGHTS

Delete your account from the extension's Account tab. This removes your account record and your active reactions, and reverses their contribution to the totals. Pseudonymous log entries and their revocations remain permanent, and a suspended account stays suspended. Access, rectification, restriction, portability and objection under GDPR/UK GDPR/CCPA/PIPEDA/PIPA. Contact: hello@emojery.app
```

## Notes to reviewer (AMO, 3000 characters)

```text
BUILD INSTRUCTIONS

Environment: Node.js 24 or newer. pnpm is pinned by the packageManager field in package.json; corepack provisions that exact version.

From the unzipped source archive:

corepack enable
pnpm install --frozen-lockfile
pnpm run zip:firefox

This emits .output/firefox-mv2/ (the unpacked extension), .output/emojery-v1.0.0-firefox-mv2.zip and .output/emojery-v1.0.0-sources.zip. Compare the rebuilt .output/firefox-mv2/ directory with the contents of the submitted package.

5 values are inlined at build time, all defined in wxt.config.ts: __EM_API_BASE_OVERRIDE__ (empty in a release build, so the bundle uses the compiled-in production API origin), __EM_STAGING_BUILD__ (false), __EM_DEBUG_LOG__ (false), __EM_I18N_FALLBACK__ (false) and __EM_BUILD_TIME__, a YYYY-MM UTC stamp shown in the popup header. The first four are constant for a release build, so the stamp is the only value that changes between rebuilds: a rebuild in the same calendar month reproduces the submitted files exactly, and a rebuild in a later month differs only in that string.

HOW TO EXERCISE THE ADD-ON

Emojery adds an emoji reaction control next to the native like/share/star buttons on supported sites and shows per-post reaction counts.

The reaction buttons and counts appear on the supported sites (x.com, facebook.com, reddit.com, instagram.com, youtube.com, github.com, gitlab.com, threads.com, amazon.com) without signing in — install and browse any of them. github.com/torvalds/linux is a reliable page to check without signing in.

To test voting (optional): open the extension, choose Sign in, enter any real email address; a 6-digit code is emailed; enter it. Use a mainstream provider - an address the code cannot be sent to is answered with an on-screen notice rather than a code, and disposable and temp-mail domains are among those refused. The code may land in spam.

VALIDATION WARNINGS

Automated validation reports 0 errors and 12 warnings. All 12 are expected.

10 x UNSAFE_VAR_ASSIGNMENT ("unsafe assignment to innerHTML") - one per bundle that carries Preact: the 9 site content scripts and the shared tracking-links chunk. Every hit is inside Preact's own diff routine, its dangerouslySetInnerHTML branch (f.__html == e.innerHTML || (e.innerHTML = f.__html)), which is inlined into each content script separately because content scripts are built as standalone bundles with no shared chunk.

Nothing in this add-on reaches that branch, and the attached source archive shows it: "grep -rn dangerouslySetInnerHTML src" returns nothing, and "grep -rn innerHTML src" returns two lines, both in src/test/setup.ts - a vitest DOM reset that ships in no artifact. The content scripts render through Preact components only.

2 x KEY_FIREFOX_UNSUPPORTED_BY_MIN_VERSION (desktop and Android) - strict_min_version is 128.0, below the 140/142 that introduced data_collection_permissions, so installs on the previous ESR keep working.
```

## Test Instructions

```text
No account is needed for the core features. Install the extension and open any supported page (youtube.com, reddit.com, github.com, gitlab.com, x.com, threads.com, facebook.com, instagram.com, amazon.com): the reaction button appears next to the site's own controls and shows the public counts. github.com/torvalds/linux is a reliable page to check without signing in.

To test reacting: open the extension popup, choose Sign in, enter any real email address, and enter the 6-digit code that arrives. Disposable and temp-mail addresses are rejected, and the code can land in spam.

"Auto-press original buttons" is off by default. Turning it on in the popup makes the emoji you pick also press the site's own control on the page you are looking at, under your own account; removing the reaction releases only what the extension pressed.
```

## AMO summary (250 characters)

```text
Emoji reactions next to the Like, Star and vote buttons you already use, on Facebook, Instagram, Reddit, YouTube, X, Threads, GitHub, GitLab and Amazon. Counts are public, recorded in a tamper-evident log and recountable by an open-source verifier.
```

## Category and tags

```text
Chrome Web Store
Category: `Social & Communication`
Tags: `emoji, reactions, react, like button, social, privacy, open source`

Microsoft Edge
Category: `Social`
Tags: `emoji, reactions, social, privacy, open source, emoji picker`
Search terms (max 7 terms, 30 characters each, 21 words total): `emoji reactions, reaction button, emoji picker, like button, react to posts, open source, privacy`

Firefox (AMO)
Category: `Social & Communication`
Tags: `emoji, reactions, like, dislike, upvote, github, reddit, transparency, privacy, open-source, social`
```

## Are you using remote code?

```text
No, I am not using remote code.
```

## Data usage declarations (CWS and Edge)

```text
Tick 5 of the 9 categories. The wording after each dash is the reason, kept here so the dashboard answer and emojery.app/browser-permissions#chrome-labels say the same thing.

  Personally identifiable information  - the email address, sent to the 2 sign-in endpoints and once more on account deletion; a keyed hash of it is the account identifier on the server, and the extension keeps the address in local storage to label the account.
  Authentication information           - the 6-digit one-time code typed at sign-in and the 30-day session token.
  Location                             - the country and city Cloudflare derives from the connection, stored with a reaction while Community insights is on; nothing finer than a city, nothing when the setting is off. The per-address request limiter uses the raw IP on Cloudflare's rate-limiting service and stores nothing beyond a windowed counter.
  Web history                          - the canonical target key of each supported item that scrolls into view is sent to fetch its count, with no account attached, and answered without being stored or logged; the pages the user reacts on are stored with the reaction, and a bug report carries the page it is about.
  Website content                      - the content script reads the page structure to find the action row and derive the item's public identifier, and sends the item's canonical link with a reaction.

Leave unticked:
  User activity                        - defined by Google as network monitoring, clicks, mouse position, scroll or keystroke logging. None is collected: no analytics library, no click or scroll telemetry, keyboard handling only inside the picker's own search box and focus trap. A submitted reaction is user content, and the timestamps and change count on its row exist so it can be changed or removed.
  Health information, Financial and payment information, Personal communications - not handled.

Certifications (all 3 ticked, and what keeps each true):
  Not sold to third parties outside the approved use cases   - nothing tied to an account leaves the service; the planned paid API serves aggregate counts that are already public in the transparency log, plus at most a per-country map above a minimum count.
  Not used or transferred for unrelated purposes             - Axiom (logs), Discord (maintainer alerts) and DeepSeek (anti-abuse second opinion, receives counts and target keys only) are operational and security processing; all are listed on emojery.app/privacy#subprocessors.
  Not used for creditworthiness or lending                   - the API terms will forbid that use for callers and their downstream recipients.
```

## Notes for certification (Edge, 2000 characters)

```text
Emojery adds an emoji reaction control next to the native Like, Star and vote buttons on 9 explicitly listed sites and shows the public reaction count for the item.

Site access is limited to those sites - no <all_urls>, and no wildcard host match beyond each site's own subdomains. Two further hosts belong to the extension itself: emojery.app for the sign-in hand-off and an installed-version marker, and api.emojery.app, the backend that serves counts, accepts reactions and handles email sign-in. No remote code is executed; the content security policy is script-src 'self'.

No account is needed to see the reaction button and the counts. Install the extension and open any supported page (youtube.com, reddit.com, github.com, gitlab.com, x.com, threads.com, facebook.com, instagram.com, amazon.com). github.com/torvalds/linux is a reliable page to check.

To test reacting: open the popup, choose Sign in, enter any real email address and enter the 6-digit code that arrives. Disposable and temp-mail addresses are rejected, and the code can land in spam.

"Auto-press original buttons" is off by default. With it on, the emoji the user picks also presses the site's own control, on the page they are looking at and under their own account - one pick presses at most one control, and removing the reaction releases only what the extension pressed.
```
