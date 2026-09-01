// SPDX-License-Identifier: GPL-3.0-or-later
//
// The per-test timeout a file needs when `vi.resetModules()` puts a COLD module-graph
// re-transform inside the timed body of each test (`await import(...)` after the reset).
// On a loaded machine that transform alone can outrun vitest's default ceiling: several
// files timed out across parallel runs while every one of them passed alone in a couple of
// seconds. The tests' own work is milliseconds; this only has to clear the transform.
//
// Called per file rather than set globally so a file that does NOT pay that cost still
// fails a genuine hang at the default, not twenty seconds later. `git grep -l
// allowColdModuleReset src` is the current list.
import { vi } from "vitest";

export function allowColdModuleReset(): void {
  vi.setConfig({ testTimeout: 20_000 });
}
