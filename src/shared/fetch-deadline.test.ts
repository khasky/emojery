// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { deadlineSignal } from "./fetch-deadline";

describe("deadlineSignal", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses AbortSignal.timeout when the engine has it", () => {
    const signal = deadlineSignal(50);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);
  });

  it("still enforces the deadline when AbortSignal.timeout is missing", async () => {
    // Regression: the old inline check silently dropped the deadline on such
    // engines, letting a hung fetch pin its in-flight slot forever.
    vi.useFakeTimers();
    vi.stubGlobal("AbortSignal", {});
    const signal = deadlineSignal(1_000);
    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(signal?.aborted).toBe(true);
  });
});
