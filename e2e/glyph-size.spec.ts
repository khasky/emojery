// SPDX-License-Identifier: GPL-3.0-or-later
//
// The trigger must read as ONE MORE ICON in the row it sits in, on every
// supported site. mount-style.ts sizes our emoji from the native control's visible icon
// (`--khasky-emojery-glyph-h`); nothing else in the suite looks at that - site-injection
// proves placement and theme-contrast proves legibility, and both pass just as happily
// with an emoji twice the size of its neighbours.
//
// Everything here is RELATIVE and read off the live page: the reference is whatever icon
// the site itself draws inside its own `nativeSelectors` on THIS page, so a restyle moves
// both numbers together.
//
// The regression it exists for: the per-site glyph memory used to outrank a row's own
// measurement, so one visit to a surface with larger icons (YouTube's Shorts rail draws
// 24px where its watch row draws 18px) resized the trigger across that platform for a 24h
// TTL. That needs state carried BETWEEN pages, which the per-site loop cannot produce -
// hence the two cases after it: a planted stale size (deterministic) and the surface order
// a user actually walks (only fails when the surfaces really differ).

import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { closeSession, envUrl, firstServiceWorker, isFirefoxRun } from "./lib/extension";
import { safeGoto } from "./lib/page-settle";
import { DEEP_QUERY_ALL_SRC } from "./lib/probe-src";
import type { SupportedSiteScenario } from "./lib/site-evidence";
import { launchE2eBrowserSession, settleAndRequireMount } from "./lib/site-session";
import { SUPPORTED_SITE_SCENARIOS } from "./supported-sites";

// How far the painted emoji may sit from the row's own icon size.
//
// Two bands, because the extension tells us which one applies. When it published
// `--khasky-emojery-glyph-h` it measured THIS row, so the sizes should nearly match. With
// the variable unset the row was unmeasurable and the trigger is on the `1.32em` fallback
// under an 18px readability floor (picker.css `--khasky-emojery-emoji-min`, so a site with
// small icons legitimately renders larger) - a coarse net that still fails the ~1.9x the
// stale-memory bug produced.
const MEASURED_BAND = { min: 0.75, max: 1.3 };
const FALLBACK_BAND = { min: 0.55, max: 1.65 };

// A real action-row icon, in CSS px. Wider than mount-style's own band on purpose: this is
// the test's independent opinion of "an icon", not a copy of the implementation's.
const ICON_SIDE_MIN_PX = 8;
const ICON_SIDE_MAX_PX = 64;

// How long a trigger is watched before its size is judged, and how often it is re-read
// while waiting. Only the LAST read is judged - see measureGlyph for why the intermediate
// ones are deliberately discarded. The window has to outlast mount.ts's own re-measure
// chain (GLYPH_REMEASURE_UNTIL_MS).
const MEASURE_SETTLE_MS = Number(process.env.E2E_GLYPH_SETTLE_MS ?? 13_000);
const MEASURE_POLL_MS = 1_000;

// How many of the nearest native matches contribute icons to the reference median.
const NATIVE_NEIGHBOURHOOD = 5;

// Planted "remembered" glyph height for the mechanism check below. No YouTube surface
// draws icons this size, so a trigger wearing it is wearing a memory, not a measurement.
const STALE_GLYPH_PX = 34;

// The storage key the plant goes into - a private contract with src/ui/mount-style-memory.ts
// (`site_glyph_v1:${site}`). Bump that version and the plant would land in a key nothing
// reads, silently turning the mechanism check into a plain placement re-run; the key
// audit after the mount is what turns that into a red run instead.
const SEEDED_GLYPH_KEY = "site_glyph_v1:youtube";

interface GlyphMeasurement {
  /** Painted size of the emoji slot (its computed font-size), CSS px. Read off the emoji
   *  itself rather than a state-specific wrapper: the same host renders `trigger-icon` when
   *  it is empty and `counter-emojis > span` once the target has public counts. */
  renderedEmojiPx: number | null;
  /** Rendered emoji box, for the failure message - sprite mode crops it to 1em square. */
  emojiBox: { width: number; height: number } | null;
  /** `--khasky-emojery-glyph-h` as the extension resolved it for THIS host, CSS px. */
  measuredGlyphPx: number | null;
  /** Median icon side inside the native control NEAREST our host, CSS px. */
  nativeIconPx: number | null;
  /** That control's icon sides, so a failure shows what the row actually contains. */
  nativeIconSides: number[];
}

// One page probe for both numbers. Source-string form: an evaluate callback is serialized
// and cannot close over the imported deep walk (lib/probe-src.ts).
const MEASURE_SRC = `(() => {
  ${DEEP_QUERY_ALL_SRC}
  const sideOf = (el) => {
    const r = el.getBoundingClientRect();
    return Math.min(r.width, r.height);
  };
  const isIconSide = (side) => side >= ${ICON_SIDE_MIN_PX} && side <= ${ICON_SIDE_MAX_PX};

  const hosts = deepQueryAll(".khasky-emojery-host").filter((h) => h.getBoundingClientRect().width > 0);
  const host = hosts[0] ?? null;
  const emoji = host ? host.shadowRoot?.querySelector(".khasky-emojery-emoji") ?? null : null;
  const iconSlot = emoji ?? (host ? host.shadowRoot?.querySelector(".khasky-emojery-trigger-icon") ?? null : null);
  const emojiRect = emoji ? emoji.getBoundingClientRect() : null;
  const hostRect = host ? host.getBoundingClientRect() : null;

  // The site's OWN control for this surface, from the scenario's nativeSelectors - never
  // our own subtree, and never a hidden one.
  const natives = NATIVE_SELECTORS.flatMap((selector) => deepQueryAll(selector))
    .filter((el) => !el.closest(".khasky-emojery-host") && el.getBoundingClientRect().width > 0);
  // An icon does not have to be an element: Amazon draws every one in its review
  // and buybox rows as a CSS sprite on an <i class="a-icon"> - measured live on the
  // US product page, ZERO svg/img inside the whole nativeSelectors set, against a
  // 16x16 popover icon and 12px stars on background-image. Reading only svg/img
  // there leaves no reference at all and the case skips, while the extension's own
  // measurement of that same row succeeded (--khasky-emojery-glyph-h: 16px). So
  // when nothing drawn measures, fall back to whatever paints an icon-sized box
  // through CSS. Fallback, not union: a row that does use svg/img keeps the
  // tighter candidate set, and its reference cannot move.
  const paintsCssIcon = (el) => {
    const style = getComputedStyle(el);
    const mask = style.maskImage || style.webkitMaskImage;
    return (style.backgroundImage && style.backgroundImage !== "none") || (mask && mask !== "none");
  };
  const iconSidesIn = (candidates) => {
    const sides = [];
    for (const candidate of candidates) {
      const side = sideOf(candidate);
      if (isIconSide(side)) sides.push(Math.round(side * 10) / 10);
    }
    return sides.sort((a, b) => a - b);
  };
  const iconSidesOf = (native) => {
    const drawn = iconSidesIn(native.matches("svg, img") ? [native] : Array.from(native.querySelectorAll("svg, img")));
    return drawn.length > 0 ? drawn : iconSidesIn(Array.from(native.querySelectorAll("*")).filter(paintsCssIcon));
  };
  const centerDistance = (el) => {
    if (!hostRect) return 0;
    const r = el.getBoundingClientRect();
    return Math.hypot(r.x + r.width / 2 - (hostRect.x + hostRect.width / 2), r.y + r.height / 2 - (hostRect.y + hostRect.height / 2));
  };
  // The control OUR host sits next to, not every match on the page: a feed carries dozens
  // of action rows plus avatars and badge dots, and pooling them measures the page instead
  // of the row. Median inside that one control, so a stray badge cannot move it.
  //
  // A NEIGHBOURHOOD of them rather than the single closest, because a scenario's
  // nativeSelectors are as coarse as the site allows: Threads matches every labelled
  // <svg>, so its "nearest native" can be a 12px verified badge sitting beside a row whose
  // action icons are 20px. Pooling the closest few and taking the median outvotes that.
  const sides = natives
    .map((native) => ({ sides: iconSidesOf(native), distance: centerDistance(native) }))
    .filter((entry) => entry.sides.length > 0)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, ${NATIVE_NEIGHBOURHOOD})
    .flatMap((entry) => entry.sides)
    .sort((a, b) => a - b);

  return {
    renderedEmojiPx: iconSlot ? Number.parseFloat(getComputedStyle(iconSlot).fontSize) : null,
    emojiBox: emojiRect ? { width: Math.round(emojiRect.width * 10) / 10, height: Math.round(emojiRect.height * 10) / 10 } : null,
    measuredGlyphPx: host ? Number.parseFloat(host.style.getPropertyValue("--khasky-emojery-glyph-h")) || null : null,
    nativeIconPx: sides.length > 0 ? sides[Math.floor(sides.length / 2)] : null,
    nativeIconSides: sides,
  };
})()`;

function readMeasurement(page: Page, site: SupportedSiteScenario): Promise<GlyphMeasurement> {
  return page.evaluate<GlyphMeasurement>(MEASURE_SRC.replace("NATIVE_SELECTORS", JSON.stringify(site.nativeSelectors ?? [])));
}

// A host counts as mounted the moment it is visible, but its size is ALLOWED to move
// afterwards (the sizing gate holds it blank until the row's icon measures, a remembered
// size may stand in, the counter's emoji paints once counts arrive). What this judges is
// where the size LANDS, so it waits out the client's own window instead of breaking on the
// first plateau: mount.ts re-measures a provisional trigger for GLYPH_REMEASURE_UNTIL_MS,
// and a late-hydrating row (YouTube watch) can hold a stand-in perfectly still for seconds
// before that correction arrives. MEASURE_SETTLE_MS must stay above that window.
async function measureGlyph(page: Page, site: SupportedSiteScenario): Promise<GlyphMeasurement> {
  const deadline = Date.now() + MEASURE_SETTLE_MS;
  let last = await readMeasurement(page, site);
  while (Date.now() < deadline) {
    await page.waitForTimeout(MEASURE_POLL_MS);
    last = await readMeasurement(page, site);
  }
  return last;
}

function describeMeasurement(site: SupportedSiteScenario, m: GlyphMeasurement): string {
  return `${site.label}: emoji ${m.renderedEmojiPx}px (glyph-h ${m.measuredGlyphPx ?? "unset"}, box ${m.emojiBox?.width}x${m.emojiBox?.height}) vs row icons ${JSON.stringify(m.nativeIconSides)} -> reference ${m.nativeIconPx}px`;
}

// Navigate, settle, require a mount - the same ladder site-injection applies (shared:
// lib/site-session settleAndRequireMount), so an anti-bot shell skips with evidence
// instead of false-failing. No key assert here: this suite judges glyph size, and a
// stale mountKeyPattern is site-injection's finding, not a size regression.
async function openAndRequireMount(page: Page, site: SupportedSiteScenario): Promise<void> {
  const navOk = await safeGoto(page, site.url);
  await settleAndRequireMount(page, site, { navOk, phase: "initial", skipLabelPrefix: "glyph-", requireMatchingKeys: false });
}

// The whole assertion, so the ordered-pair test below applies exactly the same rule.
async function expectTriggerMatchesRow(page: Page, site: SupportedSiteScenario, context: string): Promise<void> {
  const m = await measureGlyph(page, site);
  const label = `${context}${describeMeasurement(site, m)}`;
  expect(m.measuredGlyphPx ?? m.renderedEmojiPx, `${label} - a mounted host exposed neither an inherited glyph height nor a painted emoji`).not.toBeNull();

  // A surface whose own icons this probe cannot see (a font glyph, which has no box
  // to measure, or a closed shadow root) leaves nothing to compare against - don't
  // invent a reference. CSS-painted icons are NOT this case since iconSidesOf grew
  // its sprite fallback; a skip naming them again means the fallback stopped
  // reaching them. Skipped, not annotated-and-returned: the mount is all that would
  // be left asserted here, site-injection already covers that, and a green report
  // would claim this scenario's size was checked when nothing measured it.
  if (m.nativeIconPx === null) {
    test.skip(true, `${label} - this surface's own row icons are unreadable to the probe (icon font glyph / closed shadow root), so there is no reference size to compare against`);
    return;
  }

  // The size the trigger INHERITED is the quantity under test - assert it directly
  // whenever the extension published one; it is the row's own measurement, before the
  // readability floor and the counter trio's 0.87 shrink touch it.
  if (m.measuredGlyphPx !== null) {
    expectRatio(m.measuredGlyphPx / m.nativeIconPx, MEASURED_BAND, `${label} - the glyph height the trigger inherited is not this row's icon size`);
    return;
  }

  // No measurement published: the row was unmeasurable and the trigger is on the em
  // fallback. Only the painted size is left to judge, under the coarse band.
  expectRatio((m.renderedEmojiPx ?? 0) / m.nativeIconPx, FALLBACK_BAND, `${label} - the painted emoji does not read as an icon of this row`);
}

function expectRatio(ratio: number, band: { min: number; max: number }, label: string): void {
  const message = `${label} (ratio ${ratio.toFixed(2)}, allowed ${band.min}..${band.max})`;
  expect(ratio, message).toBeGreaterThanOrEqual(band.min);
  expect(ratio, message).toBeLessThanOrEqual(band.max);
}

const scenarios: SupportedSiteScenario[] = SUPPORTED_SITE_SCENARIOS.map((scenario) => ({ ...scenario, url: envUrl(scenario.urlKey) }));

const YOUTUBE_SURFACES = {
  watch: scenarios.find((s) => s.urlKey === "YOUTUBE"),
  shorts: scenarios.find((s) => s.urlKey === "YOUTUBE_SHORTS"),
};

let context: BrowserContext;
let session: Awaited<ReturnType<typeof launchE2eBrowserSession>>;

test.beforeAll(async () => {
  session = await launchE2eBrowserSession({ useGeneratedUserDataDir: true });
  context = session.context;
});

test.afterAll(async () => {
  await closeSession(session);
});

for (const site of scenarios) {
  test(`${site.label}: the trigger emoji is sized like the icons in its row`, async () => {
    test.slow();
    const page = await context.newPage();
    try {
      await openAndRequireMount(page, site);
      await expectTriggerMatchesRow(page, site, "");
    } finally {
      await page.close().catch(() => {});
    }
  });
}

// The mechanism, deterministically. The ordered pair below is the user-visible path, but
// it can only fail on a day when the two YouTube surfaces genuinely draw different icons -
// verified: against a build with the pre-fix ordering it PASSED, because that run's watch
// page happened to serve the same 24px icons as the Shorts rail. So plant the stale size
// instead of hoping the site produces one: seed the per-site glyph memory with a value no
// YouTube row has, load a page, and require the trigger to ignore it.
test("youtube: a stale remembered glyph size never outranks the row's own icons", async () => {
  test.slow();
  test.skip(isFirefoxRun(), "seeds the glyph memory through the background context, which Playwright cannot reach on Firefox (MV2 background page)");
  const site = YOUTUBE_SURFACES.watch;
  if (!site) throw new Error("Missing the YouTube watch scenario - supported-sites.ts changed");

  const seeded = await launchE2eBrowserSession({ useGeneratedUserDataDir: true });
  const page = await seeded.context.newPage();
  try {
    // The memory is read into the content script at startup, so it must be in storage
    // BEFORE the page that has to ignore it loads.
    await page.goto("about:blank").catch(() => {});
    const worker = await firstServiceWorker(seeded.context);
    await worker.evaluate(
      async ({ key, px }: { key: string; px: number }) => {
        const { chrome } = globalThis as unknown as { chrome: { storage: { local: { set: (items: Record<string, unknown>) => Promise<void> } } } };
        await chrome.storage.local.set({ [key]: { px, at: Date.now() } });
      },
      { key: SEEDED_GLYPH_KEY, px: STALE_GLYPH_PX },
    );

    await openAndRequireMount(page, site);
    await expectTriggerMatchesRow(page, site, `with a stale ${STALE_GLYPH_PX}px remembered: `);

    // The plant only proves anything if the extension READ it. It does not rewrite the
    // key it read (glyphPxOrRemembered persists only when nothing is remembered yet), so
    // a plant in the wrong key leaves the extension's own measurement in a SECOND glyph
    // key - which is exactly what this reads back.
    const glyphKeys = await worker.evaluate(async () => {
      const { chrome } = globalThis as unknown as { chrome: { storage: { local: { get: (keys: null) => Promise<Record<string, unknown>> } } } };
      // Matched on the word, not the exact prefix, so a RENAMED key shows up here too.
      return Object.keys(await chrome.storage.local.get(null))
        .filter((key) => key.toLowerCase().includes("glyph"))
        .sort();
    });
    expect(glyphKeys, `the planted glyph memory is not in the key the extension reads - src/ui/mount-style-memory.ts's site_glyph key changed, so this check had degraded into a plain placement re-run (seeded ${SEEDED_GLYPH_KEY})`).toEqual([SEEDED_GLYPH_KEY]);
  } finally {
    await page.close().catch(() => {});
    await closeSession(seeded);
  }
});

// The ordered pair. A fresh profile per case, because the defect this covers lives in
// state that outlives a navigation: the per-site glyph memory (storage + the content
// script's own map). Each order visits one surface, then the other, and asserts the
// SECOND one still matches its own row.

for (const [first, second] of [
  ["shorts", "watch"],
  ["watch", "shorts"],
] as const) {
  test(`youtube: ${first} first does not resize the trigger on ${second}`, async () => {
    test.slow();
    const firstSite = YOUTUBE_SURFACES[first];
    const secondSite = YOUTUBE_SURFACES[second];
    if (!firstSite || !secondSite) throw new Error("Missing a YouTube scenario - supported-sites.ts changed");

    // Its own profile AND its own browser: the memory is seeded from storage at content
    // script start, so reusing the suite's context would carry the previous case in.
    const ordered = await launchE2eBrowserSession({ useGeneratedUserDataDir: true });
    const page = await ordered.context.newPage();
    try {
      await openAndRequireMount(page, firstSite);
      // Read it so the visit counts even if the first surface is the unmeasurable one.
      const seed = await measureGlyph(page, firstSite);
      test.info().annotations.push({ type: "seeded-from", description: describeMeasurement(firstSite, seed) });

      await openAndRequireMount(page, secondSite);
      await expectTriggerMatchesRow(page, secondSite, `after ${first}: `);
    } finally {
      await page.close().catch(() => {});
      await closeSession(ordered);
    }
  });
}
