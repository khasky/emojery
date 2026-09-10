// SPDX-License-Identifier: GPL-3.0-or-later
//
// Run-private copy of the built extension. `wxt build` empties its output dir
// before it writes, so a rebuild that overlaps a running suite yanks
// `manifest.json` out from under every launch for a minute - three specs died
// that way mid-run under a concurrent rebuild. The runner copies
// the build once at config load (~5 MB) and points every launcher at the copy;
// a concurrent rebuild then changes nothing this run reads.
//
// Layout is `.playwright/ext-snapshot/run-*` with the extension in an `ext/`
// child, exactly the shape browser-reaper.ts already reaps: the run dir carries
// the owner-pid stamp (Chrome refuses an unpacked extension whose top level has
// a dotfile, so the stamp cannot live next to the manifest), a clean exit
// removes the dir here, and a SIGKILL'd runner leaves it for the next run's
// reaper. Loaded by the Playwright config before any fixture exists, so it
// imports nothing from the suite beyond the reaper (itself a leaf).
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { markProfileOwner } from "./browser-reaper";

const SNAPSHOT_ENV = "E2E_EXTENSION_SNAPSHOT_DIR";

/** Copy the built extension for this run and repoint the path env var at the
 *  copy. Idempotent across the config's re-evaluation in worker processes: the
 *  runner exports SNAPSHOT_ENV, workers inherit it and return early. */
export function snapshotExtensionForRun(extensionRoot: string): void {
  if (process.env[SNAPSHOT_ENV]) return;
  // Mirrors resolveExtensionPath (browser-session.ts), which cannot be imported
  // here: it pulls in @playwright/test and the fixture pipeline.
  const firefoxRun = process.env.E2E_BROWSER === "firefox";
  const pathKey = firefoxRun ? "E2E_FIREFOX_EXTENSION_PATH" : "E2E_EXTENSION_PATH";
  const source = resolve(process.env[pathKey] ?? resolve(extensionRoot, ".output", firefoxRun ? "firefox-mv2-staging" : "chrome-mv3-staging"));
  // No build yet: keep the env untouched so resolveExtensionPath raises its
  // canonical "build it first" error at launch instead of a copy failure here.
  if (!existsSync(resolve(source, "manifest.json"))) return;
  const snapshotRoot = resolve(extensionRoot, ".playwright", "ext-snapshot");
  mkdirSync(snapshotRoot, { recursive: true });
  const runDir = mkdtempSync(join(snapshotRoot, "run-"));
  void markProfileOwner(runDir);
  const extDir = resolve(runDir, "ext");
  try {
    cpSync(source, extDir, { recursive: true });
  } catch {
    // The copy raced the very rebuild it guards against (a source file vanished
    // mid-copy). Fall back to the source path - no worse than before the guard.
    rmSync(runDir, { recursive: true, force: true });
    return;
  }
  process.env[SNAPSHOT_ENV] = runDir;
  process.env[pathKey] = extDir;
  process.on("exit", () => {
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      // A straggler still holding a file: the next run's reaper takes it.
    }
  });
}
