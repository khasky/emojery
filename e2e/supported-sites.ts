// SPDX-License-Identifier: GPL-3.0-or-later
//
// The live-site scenario table the unauthenticated e2e suite drives: one entry
// per public URL a supported site must keep mounting the picker on. Kept out of
// site-injection.spec.ts so adding-a-site step 9 is a small data edit, and so the
// registry-coverage guard (src/shared/e2e-site-coverage.test.ts) can import it
// without pulling in Playwright.
//
// Data only - no Playwright import, no env read at module load. `urlKey` is the
// `E2E_URL_<KEY>` suffix; the spec resolves it through envUrl() at import time.
import type { SupportedSite } from "../src/shared/sites";

// Derived from the site registry: adding a row to SUPPORTED_SITES widens this
// union, and the coverage guard then demands a scenario for the new site.
export type SiteId = SupportedSite;
export interface SiteScenarioSpec {
  site: SiteId;
  label: string;
  urlKey: string;
  mountKeyPattern: string;
  nativeSelectors: string[];
  /** Exact visible labels of the same native controls, for a surface that names them
   *  by TEXT with no aria-label (Facebook logged out). OR'd with `nativeSelectors`. */
  nativeTextLabels?: string[];
  containerSelectors: string[];
  requiredHostAncestorSelectors?: string[];
  maxHosts?: number;
  maxVerticalDistance?: number;
  maxHorizontalDistance?: number;
  scrollSteps?: number[];
  settleMs?: number;
  isolatedContext?: boolean;
  expectHiddenNativeOnReplace?: boolean;
  /** Selectors for the native control the picker REPLACES (the Like), asserted
   *  fully invisible page-wide under replaceNative. Opt-in per scenario: only
   *  safe where the page renders no other legitimate match (e.g. the IG reel
   *  permalink - a /p/ post page also has per-comment hearts). Catches the
   *  stale-hide regression where SOMETHING got hidden (hiddenNativeCount > 0)
   *  while the real Like stayed visible. */
  replacedNativeInvisibleSelectors?: string[];
}

export const SUPPORTED_SITE_SCENARIOS: SiteScenarioSpec[] = [
  {
    site: "x",
    label: "X profile feed",
    urlKey: "X_USER",
    mountKeyPattern: "^x:\\d+$",
    nativeSelectors: [
      'article[data-testid="tweet"] button[data-testid="like"]',
      'article[data-testid="tweet"] button[data-testid="unlike"]',
      'article[data-testid="tweet"] button[aria-label$=". Like" i]',
      'article[data-testid="tweet"] button[aria-label$=". Unlike" i]',
      // Logged-out X (no testid): match the Like control by its stable action
      // ICON, which is language-independent - so this unauth check VERIFIES the
      // mount in EVERY language instead of skipping (anti-bot) or only English.
      'article button:has(svg[data-icon^="icon-heart" i])',
    ],
    containerSelectors: ['article[data-testid="tweet"]', 'div[role="group"][aria-label]', "article[data-tweet-id]", "article"],
    scrollSteps: [0, 450, 900, 1350, 1800],
    settleMs: 4_000,
  },
  {
    site: "x",
    label: "X status detail",
    urlKey: "X_POST",
    mountKeyPattern: "^x:",
    nativeSelectors: [
      'article[data-testid="tweet"] button[data-testid="like"]',
      'article[data-testid="tweet"] button[data-testid="unlike"]',
      'article[data-testid="tweet"] button[aria-label$=". Like" i]',
      'article[data-testid="tweet"] button[aria-label$=". Unlike" i]',
      // Logged-out (incognito) status page: Like by language-independent icon.
      'article button:has(svg[data-icon^="icon-heart" i])',
    ],
    containerSelectors: ['article[data-testid="tweet"]', 'div[role="group"][aria-label]', "article[data-tweet-id]", "article"],
    scrollSteps: [0, 450, 900],
    settleMs: 4_000,
    maxHosts: 1,
  },
  {
    site: "threads",
    label: "Threads profile feed",
    urlKey: "THREADS_USER",
    mountKeyPattern: "^threads:",
    nativeSelectors: ['svg[aria-label="Like"][role="img"]', 'svg[aria-label="Liked"][role="img"]', 'svg[aria-label="Unlike"][role="img"]', 'svg[role="img"][aria-label]'],
    containerSelectors: ['a[href*="/post/"]', '[role="main"]', "main"],
    scrollSteps: [0, 450, 900, 1400, 1900],
    settleMs: 3_000,
  },
  {
    site: "threads",
    label: "Threads post detail",
    urlKey: "THREADS_POST",
    mountKeyPattern: "^threads:",
    nativeSelectors: ['svg[aria-label="Like"][role="img"]', 'svg[aria-label="Liked"][role="img"]', 'svg[aria-label="Unlike"][role="img"]', 'svg[role="img"][aria-label]'],
    containerSelectors: ['a[href*="/post/"]', '[role="main"]', "main"],
    scrollSteps: [0, 450, 900, 1400],
    settleMs: 3_000,
    maxHosts: 1,
  },
  {
    site: "youtube",
    label: "YouTube watch actions",
    urlKey: "YOUTUBE",
    mountKeyPattern: "^youtube:",
    nativeSelectors: ["#top-level-buttons-computed", "segmented-like-dislike-button-view-model", ".ytSegmentedLikeDislikeButtonViewModelSegmentedButtonsWrapper", "ytd-segmented-like-dislike-button-renderer", "like-button-view-model", 'button[aria-label^="like this video" i]', 'button[aria-label^="I like this" i]'],
    containerSelectors: ["#menu.ytd-watch-metadata #top-level-buttons-computed", "ytd-watch-metadata #top-level-buttons-computed", "ytd-menu-renderer #top-level-buttons-computed"],
    requiredHostAncestorSelectors: ["#top-level-buttons-computed"],
    settleMs: 4_000,
    maxHosts: 1,
  },
  {
    site: "youtube",
    label: "YouTube Shorts vertical actions",
    urlKey: "YOUTUBE_SHORTS",
    mountKeyPattern: "^youtube:",
    nativeSelectors: [
      "reel-action-bar-view-model like-button-view-model",
      "reel-action-bar-view-model segmented-like-dislike-button-view-model",
      'reel-action-bar-view-model button[aria-label^="Like" i]',
      ".ytwReelActionBarViewModelHost like-button-view-model",
      ".ytwReelActionBarViewModelHost segmented-like-dislike-button-view-model",
      '.ytwReelActionBarViewModelHost button[aria-label^="Like" i]',
    ],
    containerSelectors: ["reel-action-bar-view-model", ".ytwReelActionBarViewModelHost", "ytd-reel-video-renderer"],
    settleMs: 4_000,
    maxHosts: 1,
    maxVerticalDistance: 260,
    maxHorizontalDistance: 220,
  },
  {
    site: "github",
    label: "GitHub repo header",
    urlKey: "GITHUB",
    mountKeyPattern: "^github:",
    // The logged-out star control is an `<a>` to /login, so every button/form
    // entry below it is dead in this suite and only the count `<span>` matched -
    // which carries no icon, and left glyph-size.spec.ts with no reference size
    // to compare the trigger against (it skipped GitHub entirely). The octicon
    // match is locale-independent and covers the starred state (`octicon-star-fill`).
    nativeSelectors: [
      'a.btn:has(svg[class*="octicon-star"])',
      "#repo-stars-counter-star",
      'div[data-component="ReactStarringButton"]',
      'form[action$="/star"]',
      'form[action$="/unstar"]',
      'button[aria-label^="Star "][aria-label*="/"]',
      'button[aria-label^="Unstar "][aria-label*="/"]',
      'button[data-testid$="star-button"]',
    ],
    containerSelectors: ["ul.pagehead-actions", "#repository-details-container", '[data-testid="repos-header-action-bar"]', 'react-app[app-name="react-code-view"]'],
    maxHosts: 1,
  },
  {
    site: "gitlab",
    label: "GitLab project header",
    urlKey: "GITLAB",
    mountKeyPattern: "^gitlab:",
    nativeSelectors: ['[data-testid="star-button"]', '[data-testid="star-count"]', ".project-repo-buttons .star-btn", ".project-repo-buttons .star-count", 'a[href$="/-/starrers"]', 'button[title*="star" i]', 'a[title*="star" i]'],
    containerSelectors: [".project-home-panel .project-repo-buttons", "header.project-home-panel .project-repo-buttons"],
    maxHosts: 1,
  },
  {
    site: "amazon",
    label: "Amazon US product page",
    urlKey: "AMAZON_US",
    mountKeyPattern: "^amazon:",
    nativeSelectors: ["#averageCustomerReviews_feature_div", "#averageCustomerReviews", "#acrPopover", '[data-feature-name="averageCustomerReviews"]', "#rightCol .a-box-group", "#desktop_buybox .a-box-group", "#buybox .a-box-group", "#outOfStockBuyBox_feature_div", "#outOfStock", "#availability_feature_div"],
    containerSelectors: ["#centerCol", "#rightCol", "#desktop_buybox", "#buybox"],
    maxVerticalDistance: 220,
    maxHorizontalDistance: 900,
    maxHosts: 1,
  },
  {
    site: "amazon",
    label: "Amazon CA product page",
    urlKey: "AMAZON_CA",
    mountKeyPattern: "^amazon:",
    nativeSelectors: ["#averageCustomerReviews_feature_div", "#averageCustomerReviews", "#acrPopover", '[data-feature-name="averageCustomerReviews"]', "#rightCol .a-box-group", "#desktop_buybox .a-box-group", "#buybox .a-box-group", "#outOfStockBuyBox_feature_div", "#outOfStock", "#availability_feature_div"],
    containerSelectors: ["#centerCol", "#rightCol", "#desktop_buybox", "#buybox"],
    maxVerticalDistance: 220,
    maxHorizontalDistance: 900,
    maxHosts: 1,
    expectHiddenNativeOnReplace: false,
  },
  {
    site: "facebook",
    label: "Facebook public page feed",
    urlKey: "FACEBOOK_PAGE",
    mountKeyPattern: "^facebook:",
    nativeSelectors: ['[role="button"][aria-label*="Like" i]', '[role="button"][aria-label*="Comment" i]', '[role="button"][aria-label*="Share" i]'],
    nativeTextLabels: ["Like", "Comment", "Share"],
    containerSelectors: ['[role="article"]', '[data-pagelet^="FeedUnit"]'],
    scrollSteps: [0, 450, 800, 1200, 1600, 2200],
    settleMs: 4_000,
    maxVerticalDistance: 260,
    maxHorizontalDistance: 900,
  },
  {
    site: "facebook",
    label: "Facebook post detail",
    urlKey: "FACEBOOK_POST",
    // A single-photo post keys on its media id (`photo:<media>` - the
    // identity shared with the photo viewer and feed card); text/video posts key
    // on the pfbid/numeric story token. All are valid URL-derivable keys.
    //
    // The one pattern nothing else can check: facebook and gitlab are excluded from the
    // registry's unit guard (src/shared/e2e-site-coverage.test.ts - their keys need page
    // state), so a drift here can only surface as a red live mount. site-injection's keyMatchDiagnostic
    // prints the keys the page derived next to this pattern, which is what tells a stale
    // pattern from a real mount regression.
    mountKeyPattern: "^facebook:(photo:\\d|pfbid|\\d)",
    nativeSelectors: ['[role="button"][aria-label*="Like" i]', '[role="button"][aria-label*="Comment" i]', '[role="button"][aria-label*="Share" i]'],
    nativeTextLabels: ["Like", "Comment", "Share"],
    containerSelectors: ['[role="article"]', '[data-pagelet^="FeedUnit"]'],
    scrollSteps: [0, 450, 800, 1200],
    settleMs: 4_000,
    maxVerticalDistance: 260,
    maxHorizontalDistance: 900,
    maxHosts: 1,
  },
  {
    site: "facebook",
    label: "Facebook reel vertical actions",
    urlKey: "FACEBOOK_REEL",
    mountKeyPattern: "^facebook:",
    nativeSelectors: ['[role="button"][aria-label*="Like" i]', '[role="button"][aria-label*="Comment" i]', '[role="button"][aria-label*="Share" i]'],
    nativeTextLabels: ["Like", "Comment", "Share"],
    containerSelectors: ['[role="article"]', '[role="main"]', "[data-video-id]", '[data-pagelet*="Reel" i]'],
    scrollSteps: [0, 450],
    settleMs: 4_000,
    maxHosts: 1,
    maxVerticalDistance: 320,
    maxHorizontalDistance: 900,
  },
  {
    site: "instagram",
    label: "Instagram public post",
    urlKey: "INSTAGRAM_POST",
    mountKeyPattern: "^instagram:",
    nativeSelectors: ['svg[aria-label="Like"]', 'svg[aria-label="Unlike"]', 'svg[role="img"][aria-label]'],
    containerSelectors: ["article", 'a[href*="/p/"]', 'a[href*="/reel/"]'],
    scrollSteps: [0, 400, 800],
    settleMs: 4_000,
    maxHosts: 1,
  },
  {
    site: "instagram",
    label: "Instagram reel vertical actions",
    urlKey: "INSTAGRAM_REEL",
    mountKeyPattern: "^instagram:",
    nativeSelectors: ['svg[aria-label="Like"]', 'svg[aria-label="Unlike"]', 'svg[role="img"][aria-label]'],
    containerSelectors: ["article", '[role="main"]', 'a[href*="/reel/"]', 'a[href*="/reels/"]'],
    scrollSteps: [0, 400],
    settleMs: 4_000,
    maxHosts: 1,
    maxVerticalDistance: 320,
    maxHorizontalDistance: 900,
    // The reel permalink renders exactly one Like (the action bar's); a stale
    // pre-hydration hide once left it visible while hiding an SSR leftover.
    replacedNativeInvisibleSelectors: ['svg[aria-label="Like"]', 'svg[aria-label="Unlike"]'],
  },
  {
    site: "reddit",
    label: "Reddit home feed",
    urlKey: "REDDIT_HOME",
    mountKeyPattern: "^reddit:t3_",
    nativeSelectors: ['shreddit-vote-animations[thing-id^="t3_"]', 'rpl-action-bar[post-id^="t3_"]', 'shreddit-post[id^="t3_"]'],
    containerSelectors: ['shreddit-post[id^="t3_"]', "article"],
    scrollSteps: [0, 500, 900, 1300, 1800],
    settleMs: 3_000,
    isolatedContext: true,
  },
  {
    site: "reddit",
    label: "Reddit post",
    urlKey: "REDDIT_POST",
    mountKeyPattern: "^reddit:t3_",
    nativeSelectors: ['shreddit-vote-animations[thing-id^="t3_"]', 'rpl-action-bar[post-id^="t3_"]', 'shreddit-post[id^="t3_"]'],
    containerSelectors: ['shreddit-post[id^="t3_"]', "article"],
    scrollSteps: [0, 350, 650, 950],
    settleMs: 3_000,
    maxHosts: 1,
    isolatedContext: true,
  },
  {
    site: "reddit",
    label: "Reddit user profile feed",
    urlKey: "REDDIT_USER",
    mountKeyPattern: "^reddit:t[13]_",
    nativeSelectors: ['shreddit-vote-animations[thing-id^="t3_"]', 'rpl-action-bar[post-id^="t3_"]', 'shreddit-post[id^="t3_"]', '[data-testid="comment"]'],
    containerSelectors: ['shreddit-post[id^="t3_"]', "article", '[data-testid="comment"]'],
    scrollSteps: [0, 500, 900, 1300, 1800],
    settleMs: 3_000,
    isolatedContext: true,
  },
];
