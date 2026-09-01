// SPDX-License-Identifier: GPL-3.0-or-later
//
// Two budgets, measured two different ways.
//
// MEMORY, differentially: deep-scroll a heavy virtualized feed with the extension loaded
// and FAIL when the renderer heap crosses the budget - the deterministic counterpart of the
// bridge suite's best-effort heap log. Long tasks are collected and attached as evidence
// only: no assert until a few weekly runs establish a stable baseline to set the threshold
// from. Opt-in (E2E_PERF=1): heap numbers vary across machines, so only the weekly CI
// environment - where the budget is being calibrated - runs it by default.
//
// RENDERING, by attribution: count the style recalculations and layouts the extension's own
// code triggers, read off the JS stack behind each trace event. That one needs no control
// run and no calibration, which is why it is not opt-in - see its own note below.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { expect, test } from "@playwright/test";
import { closeSession, envUrl, firstMountedKey, isFirefoxRun, launchSession, openGithub } from "./lib/extension";
import { dismissInterstitialsInitScript, wallReason } from "./lib/site-walls";
import { SUPPORTED_SITE_SCENARIOS } from "./supported-sites";

// Ordered candidates, most feed-like first. Reddit serves an automated browser a
// `js_challenge` redirect often enough that pinning the run to it made the budget skip on
// most weeks - a silent skip reads exactly like a pass, so the run falls through to the
// next surface instead and only skips when every one of them is walled.
//
// `find` takes the FIRST scenario registered for a site, and only the first two are feeds:
// reddit resolves to the home feed and x to a profile feed, but instagram resolves to a
// single public post and youtube to the watch page. So a fallback run measures a deep
// scroll of a DETAIL page while the title still says "a deep feed scroll" - a weaker
// measurement, not a wrong one, and the `surface` annotation records which it was.
const CANDIDATE_KEYS = ["reddit", "x", "instagram", "youtube"] as const;
const candidates = CANDIDATE_KEYS.map((site) => SUPPORTED_SITE_SCENARIOS.find((s) => s.site === site)).filter((s): s is NonNullable<typeof s> => s !== undefined);

test("a deep feed scroll stays under the heap budget", async () => {
  test.skip(process.env.E2E_PERF !== "1", "perf budget run is opt-in: set E2E_PERF=1 (nightly CI does)");
  test.skip(isFirefoxRun(), "heap/trace measurement runs over CDP - chromium-only");
  test.skip(candidates.length === 0, "no candidate scenario registered");
  test.setTimeout(300_000);
  // test.info() instead of the `({}, testInfo)` callback params: the empty
  // fixture destructuring trips biome's noEmptyPattern, and requesting the
  // `browser` fixture just to dodge it launches a second Chromium this test
  // never uses (it drives its own context via launchSession).
  const testInfo = test.info();

  const session = await launchSession();
  try {
    const page = await session.context.newPage();
    await page.addInitScript(dismissInterstitialsInitScript, { exposeUnwallHook: false, keepDialogsWithReactionHost: false });
    await page.addInitScript(() => {
      (window as unknown as { __emLongTasks: number[] }).__emLongTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) (window as unknown as { __emLongTasks: number[] }).__emLongTasks.push(Math.round(entry.duration));
        }).observe({ type: "longtask", buffered: true });
      } catch {
        // longtask unsupported: evidence array just stays empty.
      }
    });

    let scenario: (typeof candidates)[number] | null = null;
    const walled: string[] = [];
    for (const candidate of candidates) {
      const navOk = await page.goto(envUrl(candidate.urlKey), { waitUntil: "domcontentloaded", timeout: 60_000 }).then(
        () => true,
        () => false,
      );
      await page.waitForLoadState("load", { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(candidate.settleMs ?? 5_000);
      // A rendered feed is what this measurement needs, and that is a stronger
      // signal than the URL: Reddit keeps `?js_challenge=` in the address after
      // its own JS has cleared the challenge, while serving the real feed. Take
      // the surface when its native controls are actually on the page.
      const rendered = navOk ? await page.evaluate((selectors) => selectors.some((sel) => document.querySelector(sel) !== null), candidate.nativeSelectors).catch(() => false) : false;
      if (rendered) {
        scenario = candidate;
        break;
      }
      walled.push(`${candidate.site}${navOk ? ` (${(await wallReason(page)) ?? "no native controls rendered"})` : " (navigation failed)"}`);
    }
    test.skip(scenario === null, `every candidate surface was walled: ${walled.join(", ")}`);
    if (!scenario) return;
    testInfo.annotations.push({ type: "surface", description: scenario.site });

    const cdp = await session.context.newCDPSession(page);
    await cdp.send("Performance.enable");
    const heapMb = async (): Promise<number> => {
      const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: Array<{ name: string; value: number }> };
      return Math.round((metrics.find((m) => m.name === "JSHeapUsedSize")?.value ?? 0) / 1_048_576);
    };

    const before = await heapMb();
    const steps = Number(process.env.E2E_PERF_SCROLL_STEPS ?? 25);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, 1_200);
      // The measurement needs the feed to actually virtualize between steps: scrolling
      // faster than the site recycles rows measures the scroll, not the extension.
      await page.waitForTimeout(700);
    }
    // Let the last scroll's work retire before the second reading: without it the
    // delta counts allocations still in flight from the final wheel, which is
    // transient load, not the retained heap this budget is about.
    await page.waitForTimeout(3_000);
    const after = await heapMb();
    const longTasks = await page.evaluate(() => (window as unknown as { __emLongTasks?: number[] }).__emLongTasks ?? []);

    const metricsBlob = JSON.stringify({ surface: scenario.site, heapBeforeMb: before, heapAfterMb: after, scrollSteps: steps, longTaskCount: longTasks.length, longTaskTotalMs: longTasks.reduce((a, b) => a + b, 0), longTasksMs: longTasks }, null, 2);
    await testInfo.attach("perf-metrics.json", { body: metricsBlob, contentType: "application/json" });
    // test-results/ is cleared at each run start, so the attach above never
    // accumulates a baseline across weekly runs - persist explicitly via the file.
    const metricsFile = process.env.E2E_PERF_METRICS_FILE;
    if (metricsFile) {
      mkdirSync(dirname(metricsFile), { recursive: true });
      writeFileSync(metricsFile, metricsBlob);
    }

    // The whole renderer is measured, so the budget bounds "extension leak on
    // top of a heavy feed", not the extension alone. A local 12-step run on X
    // settled at 25-30 MB; the default is 25 steps, so 200 MB is deliberate slack
    // until the persisted perf-metrics.json gives a p95 for the real depth.
    const limitMb = Number(process.env.E2E_PERF_HEAP_LIMIT_MB ?? 200);
    expect(after, `renderer heap after ${steps}-step deep scroll: ${after} MB (before: ${before} MB, budget: ${limitMb} MB)`).toBeLessThan(limitMb);
  } finally {
    await closeSession(session);
  }
});

// Style recalculation and layout the EXTENSION causes, told apart from the page's own by the
// JS stack that triggered each event. `Performance.getMetrics` counts the whole renderer, and
// on a real site the page's own rendering swamps ours: a trace of youtube.com/watch attributed
// 340 style recalculations / 294 ms to YouTube's own code against 15 / 12 ms to the extension.
// A whole-renderer delta therefore cannot tell a regression in our code from the site having a
// busier day - measured across four runs of the same page it moved more than the extension's
// entire contribution. Hence a budget on what our stacks caused, not a differential.
//
// GitHub on purpose: it serves an automated browser without an anti-bot wall, so unlike the
// feed budget above this one actually runs, and its repo header mounts exactly one trigger -
// making the numbers a PER-TRIGGER budget.
const RENDER_TRACE_CATEGORIES = ["devtools.timeline", "disabled-by-default-devtools.timeline", "disabled-by-default-devtools.timeline.stack"];
// The window the trigger's post-mount re-blend schedule and glyph re-measure chain run in.
const RENDER_SETTLE_MS = 12_000;
// Headroom over what a healthy build measures (6-12 style recalculations, 3-6 layouts per
// trigger across four local runs), set to catch a multiple rather than a wobble: a re-blend
// schedule that stops self-terminating, or a read that starts forcing layout per control.
const STYLE_RECALC_BUDGET = 30;
const LAYOUT_BUDGET = 20;

interface TraceEvent {
  name: string;
  dur?: number;
  args?: { beginData?: { stackTrace?: Array<{ url?: string }> }; data?: { stackTrace?: Array<{ url?: string }> } };
}

function causedByExtension(event: TraceEvent): boolean {
  const stack = event.args?.beginData?.stackTrace ?? event.args?.data?.stackTrace ?? [];
  return stack.some((frame) => typeof frame.url === "string" && frame.url.startsWith("chrome-extension://"));
}

test("a mounted trigger stays inside its style and layout budget", async () => {
  test.setTimeout(180_000);
  test.skip(isFirefoxRun(), "render tracing runs over CDP - chromium-only");
  const testInfo = test.info();
  const session = await launchSession();
  try {
    // Tracing is browser-wide, so it is armed from a throwaway tab BEFORE the surface
    // opens - the mount and its whole re-blend schedule have to fall inside the recording.
    const armed = await session.context.newPage();
    const cdp = await session.context.newCDPSession(armed);
    const events: TraceEvent[] = [];
    cdp.on("Tracing.dataCollected", ({ value }) => events.push(...(value as unknown as TraceEvent[])));
    const traceComplete = new Promise<void>((resolve) => cdp.on("Tracing.tracingComplete", () => resolve()));
    await cdp.send("Tracing.start", { traceConfig: { includedCategories: RENDER_TRACE_CATEGORIES }, transferMode: "ReportEvents" });

    const page = await openGithub(session.context);
    await page.waitForTimeout(RENDER_SETTLE_MS);
    const mountKey = await firstMountedKey(page);

    await cdp.send("Tracing.end");
    await traceComplete;

    const ours = events.filter(causedByExtension);
    const styleRecalcs = ours.filter((e) => e.name === "UpdateLayoutTree");
    const layouts = ours.filter((e) => e.name === "Layout");
    const totalMs = (list: TraceEvent[]): number => Math.round(list.reduce((sum, e) => sum + (e.dur ?? 0), 0) / 1000);

    await testInfo.attach("render-cost.json", {
      body: JSON.stringify({ mountKey, traceEvents: events.length, styleRecalcs: styleRecalcs.length, styleMs: totalMs(styleRecalcs), layouts: layouts.length, layoutMs: totalMs(layouts) }, null, 2),
      contentType: "application/json",
    });

    // No trace at all is a broken measurement, not a pass - the counts would read zero.
    expect(events.length, "the tracing categories produced no events").toBeGreaterThan(0);
    expect(styleRecalcs.length, `extension-caused style recalculations in ${RENDER_SETTLE_MS}ms (${totalMs(styleRecalcs)}ms)`).toBeLessThanOrEqual(STYLE_RECALC_BUDGET);
    expect(layouts.length, `extension-caused layouts in ${RENDER_SETTLE_MS}ms (${totalMs(layouts)}ms)`).toBeLessThanOrEqual(LAYOUT_BUDGET);
  } finally {
    await closeSession(session);
  }
});
