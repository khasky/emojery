// SPDX-License-Identifier: GPL-3.0-or-later
//
// In-run state warm-up for the site-authenticated bridge suite.
//
// The suite assumes ONLY that the connected Chrome is logged in. Any surface
// needing a non-default account/client state - Threads with like & share counts
// hidden (a DIFFERENT action-row layout), dark rendering, Facebook group
// membership - is provisioned HERE at the start of the run and UNWOUND at the
// end, so nothing the account had before a run is left changed.
//
// Every step is best-effort and VERIFICATION-GATED: it reads the real state, acts
// only to reach the wanted state, confirms the change took, and records an undo
// ONLY for a change it confirmed. A step that can't drive a site's UI (markup
// drift, non-English account UI) leaves the account untouched. Steps never throw
// out of here; a failed revert is logged loudly.
//
// Crash safety: a confirmed change to REAL account state is journaled to
// `.playwright/warmup-journal.json` first, so a process that dies between apply
// and restore is repaired by the next run, which replays each journaled step's
// `recover()` (rebuilt from config, not a closure) before applying anything new.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Bridge } from "./bridge";
import { authFeedUrl } from "./scenarios";

// Restores one applied change to its pre-run value. Returned only when a step
// confirmed it changed something; null means "nothing changed, nothing to undo".
export type Undo = () => Promise<void>;

export interface WarmupStep {
  id: string;
  apply(bridge: Bridge): Promise<Undo | null>;
  /**
   * Replays this step's undo in a FRESH process, rebuilt from config alone -
   * used when a previous run crashed after apply. Only steps that mutate real
   * account state (journaled) need one.
   */
  recover?(bridge: Bridge): Promise<void>;
}

const JOURNAL_FILE = fileURLToPath(new URL("../../.playwright/warmup-journal.json", import.meta.url));

function readJournal(journalFile: string): string[] {
  try {
    const ids: unknown = JSON.parse(readFileSync(journalFile, "utf8"));
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function writeJournal(journalFile: string, ids: string[]): void {
  try {
    mkdirSync(dirname(journalFile), { recursive: true });
    writeFileSync(journalFile, JSON.stringify(ids));
  } catch (e) {
    console.log(`[warmup] journal write failed (${String(e).slice(0, 120)}) - a crash mid-run would need a manual revert`);
  }
}

function clearJournal(journalFile: string): void {
  try {
    rmSync(journalFile, { force: true });
  } catch {
    // best-effort; a stale journal is replayed (idempotently) next run
  }
}

// Run each step, collect the undos it confirms, and return a restore() that
// unwinds them LIFO - each guarded so one failure never blocks the rest, so the
// revert guarantee holds even if a step or the run itself threw. Before
// anything is applied, journal entries left by a crashed previous run are
// replayed via the steps' recover(). `journalFile` is injectable ONLY so a
// no-bridge self-check can point at a throwaway path - clearing the real journal
// would discard a crashed run's pending reverts; every live caller keeps the default.
export async function applyWarmups(bridge: Bridge, steps: WarmupStep[], journalFile: string = JOURNAL_FILE): Promise<Undo> {
  for (const staleId of readJournal(journalFile)) {
    const step = steps.find((s) => s.id === staleId);
    if (!step?.recover) continue;
    try {
      await step.recover(bridge);
      console.log(`[warmup] ${staleId}: recovered account state left by a crashed previous run`);
    } catch (e) {
      console.log(`[warmup] ${staleId}: recovery FAILED (${String(e).slice(0, 180)}) - restore this setting manually`);
    }
  }
  clearJournal(journalFile);

  const applied: Array<{ id: string; undo: Undo }> = [];
  for (const step of steps) {
    try {
      const undo = await step.apply(bridge);
      if (undo) {
        applied.push({ id: step.id, undo });
        // Journal only what a fresh process could recover (real account state).
        if (step.recover) {
          const recoverableIds = applied.filter((a) => steps.find((s) => s.id === a.id)?.recover).map((a) => a.id);
          writeJournal(journalFile, recoverableIds);
        }
      }
    } catch (e) {
      console.log(`[warmup] ${step.id}: skipped (${String(e).slice(0, 140)})`);
    }
  }
  return async () => {
    for (let i = applied.length - 1; i >= 0; i--) {
      const entry = applied[i];
      if (!entry) continue;
      try {
        await entry.undo();
      } catch (e) {
        console.log(`[warmup] ${entry.id}: revert FAILED (${String(e).slice(0, 180)}) - restore this setting manually`);
      }
    }
    clearJournal(journalFile);
  };
}

// Exercise the dark rendering a logged-in dark-mode user sees, via CLIENT
// color-scheme emulation instead of diving each site's settings menu: it is
// locale-independent and leaves ZERO account state changed - the undo just resets
// the emulation. It darkens sites whose theme follows the system/device setting
// (the logged-in default); an account pinned to an explicit light theme overrides
// it and stays light, in which case that account's own theme is what a run then
// exercises. Light + prefers-color-scheme are also covered logged-out by
// theme-contrast.spec.ts.
// Upgrade path: a per-site settings-menu toggle for accounts pinned to explicit light.
const darkRendering: WarmupStep = {
  id: "dark-rendering",
  async apply(bridge) {
    await bridge.act(`await page.emulateMedia({ colorScheme: 'dark' }).catch(() => {});`);
    return async () => {
      await bridge.act(`await page.emulateMedia({ colorScheme: null }).catch(() => {});`);
    };
  },
};

// Threads "Hide like and share counts" changes the ACTION-ROW markup (the count
// labels disappear), so the adapter walks a different DOM than the counts-visible
// layout the logged-out autonomous suite covers. Turn it ON for the run, restore
// the prior value after. The switch is matched by its accessible name in English;
// a non-English account isn't found and is left as-is.
// Origin taken from the run's own Threads fixture, so no live URL is hardcoded
// here (scenarios.ts). Resolved per call, not at import: only a run that reaches
// this step needs the fixture.
const threadsSettingsUrl = (): string => `${new URL(authFeedUrl("threads")).origin}/settings/account`;
const THREADS_COUNTS_SWITCH = `page.getByRole('switch', { name: /count/i }).first()`;

// Turn the hide-counts switch back OFF if it is on. Idempotent: shared by the
// in-run undo and the crashed-run recovery.
async function undoThreadsHideCounts(bridge: Bridge): Promise<void> {
  await bridge.goto(threadsSettingsUrl());
  await bridge.waitMs(2500);
  await bridge.act(
    `const sw = ${THREADS_COUNTS_SWITCH};
     if ((await sw.count().catch(() => 0)) > 0 && (await sw.getAttribute('aria-checked').catch(() => null)) === 'true') {
       await sw.click({ timeout: 5000 }).catch(() => {});
     }`,
  );
  await bridge.waitMs(800);
}

const threadsHideCounts: WarmupStep = {
  id: "threads-hide-counts",
  async apply(bridge) {
    await bridge.goto(threadsSettingsUrl());
    await bridge.waitMs(2500);
    const state = await bridge.run<{ found: boolean; on: boolean }>(
      `const sw = ${THREADS_COUNTS_SWITCH};
       if ((await sw.count().catch(() => 0)) === 0) return { found: false, on: false };
       return { found: true, on: (await sw.getAttribute('aria-checked').catch(() => null)) === 'true' };`,
    );
    if (!state.found) {
      console.log("[warmup] threads-hide-counts: switch not found (account UI language / markup drift) - leaving Threads as-is");
      return null;
    }
    if (state.on) return null; // already hidden - nothing to change or restore

    await bridge.act(`await ${THREADS_COUNTS_SWITCH}.click({ timeout: 5000 }).catch(() => {});`);
    await bridge.waitMs(1200);
    const flipped = await bridge.run<boolean>(`return (await ${THREADS_COUNTS_SWITCH}.getAttribute('aria-checked').catch(() => null)) === 'true';`);
    if (!flipped) {
      console.log("[warmup] threads-hide-counts: toggle did not take - leaving Threads as-is");
      return null;
    }
    return () => undoThreadsHideCounts(bridge);
  },
  // Recovery ceiling: the pre-run value is lost with the crashed process, so
  // recovery assumes the run flipped it ON (it only journals after doing so).
  recover: undoThreadsHideCounts,
};

// Facebook group membership for the group-feed check. Gated behind an EXPLICIT
// group URL: joining is a real social action (admin approval, notifications), so
// the run never picks a group on its own - with no E2E_WARMUP_FACEBOOK_GROUP
// set nothing is joined and the group-feed check simply skips when the account is
// in no active group. When set, the run joins the group (if not already a member)
// and LEAVES it on teardown. A group needing admin approval won't grant membership
// in time (the check still skips); the pending request is cancelled the same way.

// Leave the configured group (or cancel a pending request). Idempotent: shared
// by the in-run undo and the crashed-run recovery; the URL comes from config,
// not from run state, so a fresh process can replay it.
async function undoFacebookLeaveGroup(bridge: Bridge, url: string): Promise<void> {
  await bridge.goto(url);
  await bridge.waitMs(3000);
  // The waits in the injected script are menu/dialog beats on Facebook's own leave flow:
  // each click opens the next surface with an animation and no settled state to await.
  const left = await bridge.run<boolean>(
    `const member = page.getByRole('button', { name: /^(joined|leave group|cancel request)$/i }).first();
     if ((await member.count().catch(() => 0)) === 0) return false;
     await member.click({ timeout: 5000 }).catch(() => {});
     await page.waitForTimeout(1200);
     const menuItem = page.getByRole('menuitem', { name: /leave group/i }).first();
     if ((await menuItem.count().catch(() => 0)) > 0) { await menuItem.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(1000); }
     const confirm = page.getByRole('button', { name: /^leave group$/i }).first();
     if ((await confirm.count().catch(() => 0)) > 0) { await confirm.click({ timeout: 5000 }).catch(() => {}); await page.waitForTimeout(1000); }
     return true;`,
  );
  if (!left) console.log(`[warmup] facebook-join-group: could not confirm leaving ${url} - LEAVE IT MANUALLY`);
}

const facebookJoinGroup: WarmupStep = {
  id: "facebook-join-group",
  async apply(bridge) {
    const url = process.env.E2E_WARMUP_FACEBOOK_GROUP?.trim();
    if (!url) return null; // no group opted in - never auto-join a random one

    await bridge.goto(url);
    await bridge.waitMs(3000);
    const joined = await bridge.run<boolean>(
      // `/^join\\b/i` matches "Join" / "Join group" but NOT "Joined" (already a member).
      `const join = page.getByRole('button', { name: /^join\\b/i }).first();
       if ((await join.count().catch(() => 0)) === 0) return false;
       if (!(await join.isVisible().catch(() => false))) return false;
       await join.click({ timeout: 5000 }).catch(() => {});
       // Joining round-trips to Facebook and the button only then flips to "Joined"; the
       // caller treats this return as "membership changed", so it must not answer early.
       await page.waitForTimeout(1500);
       return true;`,
    );
    if (!joined) return null; // already a member (or no Join control) - don't touch membership

    console.log(`[warmup] facebook-join-group: requested to join ${url} - will leave it after the run`);
    return () => undoFacebookLeaveGroup(bridge, url);
  },
  async recover(bridge) {
    const url = process.env.E2E_WARMUP_FACEBOOK_GROUP?.trim();
    if (!url) {
      console.log("[warmup] facebook-join-group: journaled join found but E2E_WARMUP_FACEBOOK_GROUP is unset - leave the group manually");
      return;
    }
    await undoFacebookLeaveGroup(bridge, url);
  },
};

// The default warm-up panel applied by the lifecycle flow.
export const LIFECYCLE_WARMUPS: WarmupStep[] = [darkRendering, threadsHideCounts, facebookJoinGroup];
