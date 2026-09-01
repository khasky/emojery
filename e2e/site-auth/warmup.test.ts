// SPDX-License-Identifier: GPL-3.0-or-later
//
// Self-check of the warm-up orchestration: it must undo only the steps that
// reported a change, in LIFO order, and one failing undo must not stop the rest -
// the property the "restore after the run" guarantee rests on. The per-site UI
// navigation is exercised live by the bridge suite.
//
// No browser and no bridge, but applyWarmups does touch the FILESYSTEM: it clears
// the crash-recovery journal it is given. Every call here passes a throwaway path,
// never the real .playwright/warmup-journal.json - that file is the only record
// that a crashed run left real account state changed (a joined Facebook group, a
// flipped Threads setting), and wiping it strands the revert.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Bridge } from "./bridge";
import { applyWarmups, type Undo, type WarmupStep } from "./warmup";

const NO_BRIDGE = {} as Bridge;
const TEST_JOURNAL = join(tmpdir(), "emojery-warmup-journal.test.json");
const warmup = (steps: WarmupStep[]): Promise<Undo> => applyWarmups(NO_BRIDGE, steps, TEST_JOURNAL);

function step(id: string, undo: Undo | null, opts: { throws?: boolean } = {}): WarmupStep {
  return {
    id,
    apply: async () => {
      if (opts.throws) throw new Error("apply blew up");
      return undo;
    },
  };
}

describe("applyWarmups / restore", () => {
  it("undoes only the steps that reported a change, in LIFO order", async () => {
    const order: string[] = [];
    const restore = await warmup([
      step("a", async () => void order.push("undo-a")),
      step("b", null), // no change, so no undo
      step("c", async () => void order.push("undo-c")),
    ]);
    await restore();
    expect(order).toEqual(["undo-c", "undo-a"]);
  });

  it("a step whose apply throws is skipped without blocking later steps or undos", async () => {
    const order: string[] = [];
    const restore = await warmup([step("x", async () => void order.push("undo-x")), step("boom", null, { throws: true }), step("y", async () => void order.push("undo-y"))]);
    await restore();
    expect(order).toEqual(["undo-y", "undo-x"]);
  });

  it("one failing undo does not stop the rest from reverting", async () => {
    const reverted: string[] = [];
    const restore = await warmup([
      step("keep", async () => void reverted.push("keep")),
      step("bad", async () => {
        throw new Error("revert failed");
      }),
    ]);
    await expect(restore()).resolves.toBeUndefined(); // never throws out
    expect(reverted).toEqual(["keep"]);
  });
});
