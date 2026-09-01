// SPDX-License-Identifier: GPL-3.0-or-later
//
// Self-check of the two discriminations waitForHost has to get right: a page it
// cannot READ AT ALL is a broken bridge, and a readable page serving a
// recognized anti-bot wall is an environment failure - neither is a missing
// site login. Returning 0 for either made eight tests report "log into <site>"
// and sent the reader after a login that was never the problem.
//
// No browser and no bridge - the fakes below fail (or answer) every probe the
// way a dead tab, a -32001 storm, or a healthy hostless page does.
import { describe, expect, it } from "vitest";
import { BLOCK_URL_RE, WALL_SENTENCES_RE } from "../lib/site-walls";
import { type Bridge, BridgeError } from "./bridge";
import { waitForHost } from "./harness";

// Only the methods waitForHost touches (a no-op `reload` included - its one-shot
// re-inject recovery runs on a hostless page); a full stub would be noise. `run`
// (the wall probe) stays ABSENT unless a test provides it - the probe must
// survive a bridge without it.
function fakeBridge(evaluate: () => Promise<unknown>, run?: () => Promise<unknown>, acts?: string[]): Bridge {
  return {
    evaluate,
    ...(run ? { run } : {}),
    reload: async () => {},
    act: async (body: string) => {
      acts?.push(body);
    },
    waitMs: async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5)));
    },
  } as unknown as Bridge;
}

// What a real failed call now hands a caller: bridge.ts mints every one of them as
// a BridgeError, precisely so a helper can tell "the bridge said nothing" from "the
// page said no". A plain Error here would be a probe that threw in the page, which
// these helpers must NOT swallow - see the last case in this describe.
const BRIDGE_FAILURE = "MCP error -32001: Request timed out";
const bridgeFailure = (): BridgeError => new BridgeError(BRIDGE_FAILURE);

describe("waitForHost", () => {
  it("throws naming the bridge when every probe fails", async () => {
    const bridge = fakeBridge(() => Promise.reject(bridgeFailure()));
    await expect(waitForHost(bridge, "github", 40)).rejects.toThrow(/bridge/i);
  });

  it("blames neither the site nor the login, and keeps the probe failure as cause", async () => {
    const bridge = fakeBridge(() => Promise.reject(bridgeFailure()));
    const error = await waitForHost(bridge, "github", 40).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).not.toMatch(/log into/i);
    expect(String(error?.cause)).toContain(BRIDGE_FAILURE);
  });

  it("still reports 0 when the page reads fine but carries no host", async () => {
    const bridge = fakeBridge(async () => ({ visibleHostCount: 0 }));
    await expect(waitForHost(bridge, "github", 40)).resolves.toBe(0);
  });

  it("swallows a failed probe once any probe answered", async () => {
    let reads = 0;
    const bridge = fakeBridge(async () => {
      reads += 1;
      if (reads === 2) throw bridgeFailure();
      return { visibleHostCount: 0 };
    });
    await expect(waitForHost(bridge, "github", 40)).resolves.toBe(0);
  });

  it("gives up on the SECOND lost read in a row instead of riding out the ceiling", async () => {
    // Each real stall costs ~61s (the call ceiling plus its retry) and the loop
    // refunds that time, so without this the wait holds a dead relay open for its
    // whole hard ceiling - and scrollAndCountHosts pays it once per scroll step.
    let reads = 0;
    const bridge = fakeBridge(async () => {
      reads += 1;
      if (reads === 1) return { visibleHostCount: 0 };
      throw bridgeFailure();
    });
    await expect(waitForHost(bridge, "github", 60_000)).rejects.toThrow(/bridge/i);
    expect(reads, "the third read is already past the verdict").toBe(3);
  });

  it("names the wall, not the login, when a zero-host page is a recognized wall", async () => {
    const bridge = fakeBridge(
      async () => ({ visibleHostCount: 0 }),
      async () => 'anti-bot interstitial: "Prove your humanity"',
    );
    const error = await waitForHost(bridge, "reddit", 40).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toMatch(/anti-bot/i);
    expect(error?.message).not.toMatch(/log into/i);
  });

  it("blames the bridge when stalled probes, not the page, consumed the budget", async () => {
    // One good read then nothing but stalls: the old loop refunded nothing, so
    // the very first stall closed the window and returned 0 - "log into <site>"
    // for a wedged bridge. Stall length is well under the 30s the real bridge
    // pays, and still has to outlast the budget.
    let first = true;
    const bridge = fakeBridge(async () => {
      if (first) {
        first = false;
        return { visibleHostCount: 0 };
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
      throw bridgeFailure();
    });
    await expect(waitForHost(bridge, "github", 40)).rejects.toThrow(/bridge/i);
  });

  it("sweeps back up, so a long wait cannot walk off a single-target page", async () => {
    // The nudge used to only ever wheel DOWN: over a 60s detail-page budget that
    // walks ~12000px past the action row whose IntersectionObserver mount the
    // wait is there to catch, and no later read can recover.
    const acts: string[] = [];
    const bridge = fakeBridge(async () => ({ visibleHostCount: 0, hostCount: 0, siteKeyCount: 0 }), undefined, acts);
    await waitForHost(bridge, "github", 300);
    const deltas = acts.map((body) => Number(/wheel\(0, (-?\d+)\)/.exec(body)?.[1] ?? 0));
    expect(deltas.length, "the wait should have nudged several times").toBeGreaterThan(5);
    let offset = 0;
    let furthest = 0;
    for (const d of deltas) {
      offset += d;
      furthest = Math.max(furthest, offset);
    }
    expect(furthest, "the sweep must stay within one cycle of the starting position").toBeLessThanOrEqual(2400);
    expect(
      deltas.some((d) => d < 0),
      "the sweep must come back up",
    ).toBe(true);
  });

  it("charges a stalled NUDGE to the bridge, never to the page", async () => {
    // The live failure this exists for: the nudge is a bridge call like any other,
    // but it was the one nobody caught - so a stall in it ran the budget out while
    // the reads kept answering 0, and the caller printed "log into Facebook" at an
    // account that was signed in (both wall audits and the threads round-trip).
    const bridge = fakeBridge(async () => ({ visibleHostCount: 0, hostCount: 0, siteKeyCount: 0 }));
    (bridge as unknown as { act: () => Promise<void> }).act = () => Promise.reject(bridgeFailure());
    const error = await waitForHost(bridge, "facebook", 40).then(
      () => null,
      (err: unknown) => err as Error,
    );
    expect(error?.message, "a nudge the bridge could not run is not a missing login").toMatch(/bridge/i);
    expect(error?.message).not.toMatch(/log into/i);
  });

  it("keeps reporting 0 when the wall probe itself fails", async () => {
    const bridge = fakeBridge(
      async () => ({ visibleHostCount: 0 }),
      () => Promise.reject(bridgeFailure()),
    );
    await expect(waitForHost(bridge, "github", 40)).resolves.toBe(0);
  });
});

// Pins the shared wall fixtures to the two walls Reddit actually served this
// suite's own fixture URLs (captured live): the js_challenge redirect into the
// network-security block, and the "Prove your humanity" reCAPTCHA on a CLEAN
// URL - which is why the text set must exist at all.
describe("wall fixtures", () => {
  it("recognizes both Reddit walls by sentence and the challenge redirect by URL", () => {
    expect(WALL_SENTENCES_RE.test("You've been blocked by network security.")).toBe(true);
    expect(WALL_SENTENCES_RE.test("Prove your humanity")).toBe(true);
    // Synthetic permalink of the real shape (obviously-fictional ids) - the
    // assertion is about the URL form, not any live post.
    expect(BLOCK_URL_RE.test("https://www.reddit.com/r/emojery_e2e_fixture/comments/0abc123/fixture_post/?solution=abc&js_challenge=1&token=t")).toBe(true);
    expect(BLOCK_URL_RE.test("https://www.reddit.com/r/emojery_e2e_fixture/comments/0abc123/fixture_post/")).toBe(false);
  });
});
