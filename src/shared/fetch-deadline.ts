// SPDX-License-Identifier: GPL-3.0-or-later
//
// Deadline signal for outbound fetches. AbortSignal.timeout where the engine
// has it; otherwise a manual AbortController so the deadline never silently
// disappears (a hung fetch pins in-flight dedupe slots for the life of the
// worker). The fired timer on a settled fetch is a no-op abort.

export function deadlineSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  if (typeof AbortController === "undefined") return undefined;
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error(`timeout after ${ms}ms`)), ms);
  return controller.signal;
}
