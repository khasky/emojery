# Store Listing Copy (CWS / Edge / AMO / Opera)

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

No account is needed to read counts. To add a reaction, sign in with a personal Google, Apple or Microsoft account you already have; work and school accounts are not supported, and you must be 16 or older. These reactions are counted separately from the site's native Likes, stars and votes. Firefox for Android shows counts only: signing in and reacting need the desktop browser.

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

One personal account gets one reaction per post; each reaction is signed on your device and published in an open log under a pseudonym, never your name or email, so anyone can recount the totals with the free, open-source verifier. About every 30 minutes the log is anchored in Sigstore's public Rekor log and mirrored to a public GitHub repository, which Software Heritage archives on its own.

Anti-abuse checks help limit spam. Reactions found to be abuse are revoked, and every revocation is recorded in the public log.

PRIVACY AND DATA

- Every reaction you make is published to anyone, permanently, in Emojery's public log under your pseudonym. Reactions to political or religious posts can reveal your views.
- No ads, no third-party trackers, no analytics.
- Sign-in goes through the provider's own login page and asks only for the OpenID sign-in, never your email or profile. The extension never sees your password; your account is identified by a pseudonym derived from the provider's answer.
- Your browsable history stays on your device. To show counts, the extension sends the public identifiers of items on screen. Submitted reactions are stored with the public identifier of the item. With each reaction the service keeps its time, the country and the network it came from for 30 days, for anti-abuse only.
- Account deletion removes your reactions from the counts; entries already published stay in the log under your pseudonym.

SUPPORTED SITES

Emojery currently supports 14 sites, including Facebook, Instagram, Reddit, YouTube and GitHub. Check https://emojery.app for the full list and supported content types.

Reactions are available on supported public content. Site support and fixes come through extension updates. You can request another site in the source repository.

ABOUT THE PROJECT

Emojery is free, donation-funded and open source under GPL-3.0. Built by one developer, it is currently in public beta.

Source code and site requests: https://github.com/khasky/emojery
Privacy policy: https://emojery.app/privacy

Emojery is an independent project. All product names, logos and trademarks are the property of their respective owners.
```

## Single purpose description

```text
Emojery adds 600+ emoji reactions beside the Like, Star and vote buttons on supported websites. Go beyond the built-in reaction menu, choose a more specific response and see what other users selected. Reading the counts needs no account.
```

## AMO summary (250 characters)

```text
Emojery adds 600+ emoji reactions beside the Like, Star and vote buttons on supported websites. Go beyond the built-in reaction menu, choose a more specific response and see what other users selected. Free, open source, no ads.
```

## storage justification

```text
Used to save extension settings, per-site preferences, the signed-in session (the session token and the name of the provider it was opened with, kept only to label the account in the popup), the name and emoji mark this device shows for each account signed in on it, the settings each of those accounts changed away from the defaults, recently used emoji, local reaction state and a 30-second cache of counts. Only the settings object syncs through the browser's extension-settings sync; the session, the per-account records, the cache and the reaction state stay on the device. These values support the reaction picker, the account session and consistent behavior between visits.
```

## unlimitedStorage justification

```text
Used to retain the user's local reaction history in IndexedDB as it grows beyond default storage quotas and to protect it from automatic storage eviction. This supports history search, filtering, export and restoration. The browsable history database is not uploaded to Emojery's servers; submitted reactions are processed separately by the reaction service.
```

## alarms justification

```text
Used to schedule short background tasks that retry queued reactions after temporary connection failures and periodically refresh the list of most-used emoji shown at the top of the picker. This lets pending submissions resume without keeping the extension's background service worker continuously running.
```

## activeTab justification

```text
Used when the user opens the extension from the browser toolbar to inspect the active tab's URL, determine whether the current site is supported and display the appropriate site status and controls. Access is triggered by the user's action and is not used to monitor unrelated tabs or retrieve the browser's browsing-history database.
```

## identity justification

```text
Used only for sign-in: identity.launchWebAuthFlow opens the chosen provider's own login page (Google, Apple or Microsoft) in a window the browser controls and returns the backend's redirect to the extension, so no extension page ever hosts a provider's form and no password passes through the extension. The optional identity.email permission is not requested; the browser profile's own account is never read.
```

## scripting justification

```text
Used to inject the extension's packaged content scripts into already-open supported pages when the extension is installed, so the reaction interface appears without requiring a page reload. Injection is restricted to supported host patterns. The scripts add the reaction interface and run from files included in the submitted extension package.
```

## Host permission justification

```text
Access to the listed Facebook, Instagram, Reddit, YouTube, X, Threads, GitHub, GitLab, Amazon, Rotten Tomatoes, TMDB, IMDb, Metacritic and OpenCritic hosts is required to identify supported public content, insert the reaction interface and display its counts. User-enabled settings can hide native controls and link an emoji selection to a native reaction or vote on the current page; Auto-press is off by default. Access to api.emojery.app supports count lookups, the provider sign-in and the registration of the device key that signs reactions, reaction submissions and removals, account deletion and user-submitted bug reports. Access to emojery.app lets a packaged script expose the installed version and handle reaction links. Content scripts run only on the declared supported hosts, not arbitrary websites.
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
Emojery collects the minimum needed to make a reaction count. This is a summary; the full policy at https://emojery.app/privacy is the one that applies.

WHAT IS PUBLIC

Every reaction you make, and every change or removal, is published to anyone, permanently, in Emojery's public log under your pseudonym. The log shows the pseudonym, the sign-in provider, your device's public key, the public page and the emoji; never your name, email or IP address, and no time finer than its publication. Reactions to political or religious posts can reveal your views.

WHAT LEAVES YOUR BROWSER

- To show counts, the public identifiers of supported items that scroll into view, before you react. While you are signed in, a second request asks which of those items you have already reacted to.
- At sign-in, the id_token from the provider you choose (Google, Apple or Microsoft, personal accounts only), requested with the OpenID scope only: no email, no profile. The service checks it once and derives your pseudonym from it with a secret salt. Your device creates its own key, which never leaves it, and signs every reaction with it.
- The reactions you submit, with the public identifier of the item you reacted to. With each one the service keeps, for anti-abuse only, its time, the country and the network it came from.
- A bug report, only when you send one from the Report tab: your note, the page it is about and the extension version.

WHAT IS NEVER COLLECTED

Names, email addresses, passwords, city or finer location, device fingerprints, advertising cookies or tracking pixels, and any record of pages you did not react on. The extension loads no analytics SDK.

STORAGE AND RETENTION

Provider id_token: never stored. Session token: 30 days, in extension storage, renewed by your device key. Reaction context (time, page, country, network): 30 days. Account record and active reactions: until you delete them. Public log entries: permanent. The full table with every period is at https://emojery.app/privacy#retention.

WHERE YOUR REACTIONS LIVE

Your device keeps the browsable history, including page titles, in the browser's IndexedDB, and it is never uploaded. The service keeps your current reaction per item and publishes the log.

SUBPROCESSORS AND RECIPIENTS

Subprocessors: Cloudflare (infrastructure), Neon (managed database), Backblaze (backups), GitHub (the log mirror), Axiom (backend logs, 30 days), Discord (the maintainer's private alerts), Bitwarden (secrets), and the sign-in provider you choose, under its own privacy policy. The public log and its checkpoint hashes are also copied by independent recipients: Sigstore Rekor, Software Heritage, and, once the launch trial period ends, Zenodo and the Internet Archive. The current list is at https://emojery.app/privacy#subprocessors.

YOUR RIGHTS

Delete your account from the extension's Account tab: your reactions are removed from the counts and the data the service holds about you is erased; entries already published stay in the log under your pseudonym. You can object at any time to the use of your data for the public log and anti-abuse; deleting your account is the quickest way. Access, rectification, restriction and portability under GDPR/UK GDPR/CCPA/PIPEDA/PIPA. Contact: hello@emojery.app
```

## Release notes (AMO and the Opera changelog, 1.1.0)

Opera takes the same text without the Firefox picker clause in the last line.

```text
- Sign in with a personal Google, Apple or Microsoft account; the email code is gone. Each reaction is signed on your device and published in the open log under a pseudonym.
- Reactions on five more sites: Rotten Tomatoes, TMDB, IMDb, Metacritic and OpenCritic.
- Several accounts on one device, each with its own settings and its own emoji mark.
- Reactions made offline or during a dropped connection are queued and sent later.
- An outdated version now asks you to update instead of failing silently.
- Fixes for Facebook, X, Threads, YouTube Shorts, GitHub and GitLab layouts, and for the picker in Firefox.
```

## Notes to reviewer (AMO, 3000 characters)

```text
BUILD INSTRUCTIONS

Node.js 24 or newer; pnpm is pinned by the packageManager field in package.json and corepack provisions that exact version. From the unzipped source archive:

corepack enable
pnpm install --frozen-lockfile
pnpm run zip:production:firefox

Compare the rebuilt .output/firefox-mv2/ directory with the submitted package.

Two things in the source are absent from that output by a build-time constant in wxt.config.ts: the console debug channels and their redactor (__EM_DEBUG_LOG__), and the English fallback dictionary used only by unit tests (__EM_I18N_FALLBACK__). __EM_API_BASE__ is why the API origin appears in the bundle as a literal (src/shared/api-origins.ts).

HOW TO TEST

The reaction button and counts appear without signing in on the 14 supported sites (x.com, facebook.com, reddit.com, instagram.com, youtube.com, github.com, gitlab.com, threads.com, amazon.com, rottentomatoes.com, themoviedb.org, imdb.com, metacritic.com, opencritic.com). github.com/torvalds/linux is a reliable page.

To test reacting (desktop Firefox): open the extension, choose Sign in, tick both boxes and pick Google, Apple or Microsoft; sign in with a personal account on the provider's own page in the window that opens. Firefox for Android has no identity.launchWebAuthFlow, so there the add-on shows counts only.

VALIDATION WARNINGS: 0 errors, 17 warnings, all expected

15 x "Unsafe assignment to innerHTML" - one per bundle that carries Preact (the 14 site content scripts and the shared tracking-links chunk). Each hit is Preact's own dangerouslySetInnerHTML branch (f.__html == e.innerHTML || (e.innerHTML = f.__html)), inlined because content scripts are standalone bundles. Nothing reaches it: "grep -rn dangerouslySetInnerHTML src" returns nothing, and the only innerHTML in src is the unit-test DOM reset, which does not ship.

2 x "Manifest key not supported by the specified minimum version" - strict_min_version is 130.0 (the device key needs Ed25519 in WebCrypto), below the 140/142 that introduced data_collection_permissions. Firefox 130 to 139 get the extension's own data-collection disclosure on install instead.
```

## Test Instructions (CWS, 500 characters)

```text
No account is needed to see the reaction button and counts: open a supported page such as github.com/torvalds/linux or any YouTube video.

To test reacting: open the popup, choose Sign in, tick both boxes and pick Google, Apple or Microsoft; sign in with a personal account in the window that opens.

"Auto-press original buttons" is off by default; when on, the picked emoji also presses the site's own button under the user's account.
```

## Message to moderators (Opera)

```text
Emojery adds an emoji reaction control next to the native Like, Star and vote buttons on 14 explicitly listed sites and shows the public reaction count for the item. The package is the same Chromium MV3 build submitted to the Chrome Web Store and Edge Add-ons.

BUILD INSTRUCTIONS

The JavaScript is bundled by WXT (Vite); the attached source archive is the input. Environment: Node.js 24 or newer; pnpm is pinned by the packageManager field in package.json and corepack provisions that exact version. From the unzipped source archive:

corepack enable
pnpm install --frozen-lockfile
pnpm run zip:production:chrome

This emits .output/chrome-mv3/ (the unpacked extension) and .output/emojery-v<version>-chrome-mv3.zip; compare .output/chrome-mv3/ with the submitted package. The source is also public: https://github.com/khasky/emojery (tag v<version>).

PERMISSIONS

Site access is limited to the listed sites - no <all_urls>. Two further hosts belong to the extension itself: emojery.app for the sign-in hand-off and an installed-version marker, and api.emojery.app, the backend that serves counts, accepts reactions and completes the provider sign-in. identity is used only for sign-in: it opens the provider's own login page in a browser window. No remote code is executed; the content security policy is script-src 'self'.

HOW TO TEST

No account is needed to see the reaction button and the counts. Open any supported page (youtube.com, reddit.com, github.com, gitlab.com, x.com, threads.com, facebook.com, instagram.com, amazon.com, rottentomatoes.com, themoviedb.org, imdb.com, metacritic.com, opencritic.com); github.com/torvalds/linux is a reliable page to check.

To test reacting: open the popup, choose Sign in, tick both boxes and pick a provider (Google, Apple or Microsoft); sign in with a personal account on the provider's own page in the window that opens.

"Auto-press original buttons" is off by default. With it on, the emoji the user picks also presses the site's own control, on the page they are looking at and under their own account; removing the reaction releases only what the extension pressed.
```

## Opera listing fields

```text
Extension source code URL (public):          https://github.com/khasky/emojery
Extension source code URL (for moderators):  https://github.com/khasky/emojery/tree/v<version>
License URL:                                 https://github.com/khasky/emojery/blob/v<version>/LICENSE
Privacy policy URL:                          https://emojery.app/privacy
```

## Build instructions (Opera)

```text
1. OS: Ubuntu (the release builds run on GitHub Actions ubuntu-latest); Windows 10 also builds it.
2. Tools: Node.js 24 (24.15.0 tested; .nvmrc says 24). pnpm 11.22.0, pinned by the packageManager field in package.json and provisioned by corepack, which ships with Node.js. No other global tools.
3. From the unzipped source archive (or a checkout of the tag v<version> of https://github.com/khasky/emojery):

corepack enable
pnpm install --frozen-lockfile
pnpm run zip:production:chrome

The unpacked extension is .output/chrome-mv3/ and the package is .output/emojery-v<version>-chrome-mv3.zip; compare .output/chrome-mv3/ with the submitted package.
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
Tick 6 of the 9 categories. The wording after each dash is the reason, kept here so the dashboard answer and emojery.app/browser-permissions#chrome-labels say the same thing. Every reaction is published in the open log under a pseudonym; the listing and the sign-in screen both say so.

  Authentication information           - the provider's id_token, checked once at sign-in, and the account identifier derived from it; the 30-day session token; the device key that signs each reaction.
  Personally identifiable information  - ticked conservatively: the account is identified by a pseudonymous identifier derived from the provider's account. No name, email address or other contact detail is collected.
  Location                             - the country and network derived from the connection, kept with each reaction for 30 days, for anti-abuse only. Nothing finer than a country.
  User activity                        - which public pages the user reacted on: each reaction is stored and published with the page's public identifier.
  Web history                          - the public identifier of each supported item that scrolls into view is sent to fetch its count; the pages the user reacts on are stored with the reaction, and a bug report carries the page it is about.
  Website content                      - the content script reads the page structure to find the action row and derive the item's public identifier.

Leave unticked:
  Health information, Financial and payment information, Personal communications - not handled.

Certifications (all 3 ticked, and what keeps each true):
  Not sold to third parties outside the approved use cases   - nothing is sold; the planned paid API serves only data already public in the transparency log.
  Not used or transferred for unrelated purposes             - Axiom (logs) and Discord (maintainer alerts) are operational and security processing; all subprocessors are listed on emojery.app/privacy#subprocessors.
  Not used for creditworthiness or lending                   - the API terms will forbid that use for callers and their downstream recipients.
```

## Notes for certification (Edge, 2000 characters)

```text
Emojery adds an emoji reaction control next to the native Like, Star and vote buttons on 14 explicitly listed sites and shows the public reaction count for the item.

Site access is limited to those sites - no <all_urls>, and no wildcard host match beyond each site's own subdomains. Two further hosts belong to the extension itself: emojery.app for the sign-in hand-off and an installed-version marker, and api.emojery.app, the backend that serves counts, accepts reactions and completes the provider sign-in. No remote code is executed; the content security policy is script-src 'self'.

No account is needed to see the reaction button and the counts. Install the extension and open any supported page (youtube.com, reddit.com, github.com, gitlab.com, x.com, threads.com, facebook.com, instagram.com, amazon.com, rottentomatoes.com, themoviedb.org, imdb.com, metacritic.com, opencritic.com). github.com/torvalds/linux is a reliable page to check.

To test reacting: open the popup, choose Sign in, tick both boxes and pick a provider (Google, Apple or Microsoft); sign in with a personal account on the provider's own page in the window that opens. The identity permission is what opens that window; the extension never hosts the provider's form.

"Auto-press original buttons" is off by default. With it on, the emoji the user picks also presses the site's own control, on the page they are looking at and under their own account - one pick presses at most one control, and removing the reaction releases only what the extension pressed.
```
