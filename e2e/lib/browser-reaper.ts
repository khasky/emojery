// SPDX-License-Identifier: GPL-3.0-or-later
//
// Phantom-browser reaper. Playwright closes its browsers on a normal exit and on
// Ctrl-C, but a SIGKILL'd runner (a killed background job, an OOM, a crashed CI
// step) leaves the whole browser tree alive - a headed Chromium or Firefox with
// no parent, holding a `.playwright/<name>/run-*` profile and a few hundred MB.
// Nothing in-process can run after SIGKILL, so the only fix is to reap: this
// module is wired as BOTH `globalSetup` and `globalTeardown` (see
// e2e/playwright.config.ts), so every run starts by burying the previous run's
// dead and ends by burying its own.
//
// TWO rules find an orphan, because the suites launch browsers two ways:
//
//   1. Stamped profile. `makeRunProfileDir` writes the minting pid into each
//      `.playwright/<name>/run-*`, and the profile is an orphan only when that
//      pid is GONE. Covers everything that goes through `launchRealisticContext`
//      - the whole Playwright e2e suite, chromium and firefox alike.
//   2. Dead parent. `pnpm test:browser` (Vitest browser mode) launches WebKit and
//      Gecko through its own provider, into a temp profile outside `.playwright`,
//      so rule 1 never sees them. Those are orphans when their PARENT is gone -
//      qualified by the executable living under the Playwright browsers dir, so a
//      real Chrome the user is browsing in can never match.
//
// Both rules are safe against a CONCURRENT run for the same reason: a sibling
// session still has live workers, so neither its profile stamps nor its browsers'
// parents are dead. At teardown THIS run's workers have already exited, which is
// what makes its own leftovers reapable then. A profile with no stamp (an older
// run, an explicit E2E_USER_DATA_DIR) is never touched - unknown ownership is not
// our call.
//
// A LEAF module by the same rule as lib/launch-args.ts: it is loaded by the
// Playwright config before any fixture exists, so it imports nothing from the
// suite and nothing outside `node:*`.
import { execFile } from "node:child_process";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const OWNER_FILE = ".e2e-owner";

// From the working directory, not from this file's own location: the module is
// loaded two different ways - through the spec pipeline (CJS, `__dirname`) and
// as the config's globalSetup (ESM, `import.meta.url`) - and neither identifier
// exists in both. Every entry point (`pnpm test:e2e`, `pnpm exec playwright test
// -c e2e/...`) runs from the package root, which is where `.playwright` lives.
// Run from somewhere else and the reap finds no profiles and does nothing, which
// is the right way for this to be wrong.
function profileRoot(): string {
  return resolve(process.cwd(), ".playwright");
}

/** Stamp a freshly minted profile with the pid that owns it. Best-effort: a
 *  profile that fails to stamp is simply never reaped. */
export async function markProfileOwner(dir: string): Promise<void> {
  await writeFile(resolve(dir, OWNER_FILE), String(process.pid), "utf8").catch(() => {});
}

function isPidAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering anything.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM means the pid exists but belongs to someone else - alive, not ours.
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function orphanProfileDirs(): Promise<string[]> {
  const orphans: string[] = [];
  const root = profileRoot();
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const base = resolve(root, name);
    for (const entry of await readdir(base).catch(() => [] as string[])) {
      if (!entry.startsWith("run-")) continue;
      const dir = resolve(base, entry);
      const stamp = await readFile(resolve(dir, OWNER_FILE), "utf8").catch(() => "");
      const owner = Number.parseInt(stamp.trim(), 10);
      if (!Number.isInteger(owner) || owner <= 0) continue;
      if (isPidAlive(owner)) continue;
      orphans.push(dir);
    }
  }
  return orphans;
}

// `<pid> <command line>`, one process per line, on both platforms. Deliberately
// NOT ConvertTo-Json: Windows PowerShell serializes the table through the console
// encoding and a single command line with an unpaired surrogate or a stray quote
// takes the whole parse down with it (observed: `Unexpected token in JSON`, and
// with it every reap). A pid, a tab and the rest of the line cannot fail that way.
interface ProcessRow {
  pid: number;
  ppid: number;
  cmd: string;
}

async function listProcesses(): Promise<ProcessRow[]> {
  // 32 MB: a full process table with command lines on a busy dev machine is well
  // under that, and the default 1 MB is not.
  const maxBuffer = 32 * 1024 * 1024;
  const [bin, argv] = process.platform === "win32" ? (["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ParentProcessId)`t$($_.CommandLine)" }']] as const) : (["ps", ["-eo", "pid=,ppid=,args="]] as const);
  const { stdout } = await execFileAsync(bin, [...argv], { maxBuffer, windowsHide: true }).catch(() => ({ stdout: "" }));
  return (
    stdout
      // `\r?\n`, not `\n`: PowerShell ends lines with CRLF, `.` does not match the
      // carriage return (it is a line terminator), and the trailing `\r` then keeps
      // `$` from matching - every row parsed to null and the reaper found nothing.
      .split(/\r?\n/)
      .map((line) => /^\s*(\d+)[\t ]+(\d+)[\t ]+(.+)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: (m[3] ?? "").trim() }))
  );
}

// The EXECUTABLE, not the arguments. Without this, the profile-path needle below
// would also match a grep, an editor or a debug script that merely NAMES the
// path - and killing one of those is a far worse bug than the phantom it cleans
// up. A quoted path wins over the first-space split, which is how Windows spells
// an executable living under `Program Files`.
function executableOf(cmd: string): string {
  const quoted = /^"([^"]+)"/.exec(cmd);
  return (quoted?.[1] ?? cmd.split(" ")[0] ?? "").toLowerCase();
}

function isBrowserProcess(cmd: string): boolean {
  return /chrome|chromium|firefox|msedge|headless_shell/.test(executableOf(cmd));
}

// Only a browser Playwright itself downloaded and runs. This is what keeps rule 2
// off a real Chrome or Firefox the user has open: those live under the OS install
// path, never under the browsers dir (`PLAYWRIGHT_BROWSERS_PATH`, or the default
// `.../ms-playwright/`), so no browsing session can look like a phantom.
function isPlaywrightManaged(cmd: string): boolean {
  const dir = (process.env.PLAYWRIGHT_BROWSERS_PATH || "ms-playwright").replace(/\\/g, "/").toLowerCase();
  return executableOf(cmd).replace(/\\/g, "/").includes(dir);
}

// Rule 2's orphan test, which is spelled differently per platform. Windows leaves
// a dead parent's pid dangling, so "parent gone" reads directly. POSIX reparents
// an orphan to init instead, so a LIVE ppid of 1 is the same fact. Guard the
// non-pids: `process.kill(0, 0)` signals our own process group, which is the last
// thing a reaper should do.
function isOrphanedByParent(ppid: number): boolean {
  if (!Number.isInteger(ppid) || ppid <= 0) return false;
  return process.platform === "win32" ? !isPidAlive(ppid) : ppid === 1;
}

async function killTree(pid: number): Promise<void> {
  if (process.platform === "win32") {
    // /T takes the content processes with it; Chromium and Firefox both spawn a
    // fan of them and a bare kill of the parent orphans the fan in turn.
    await execFileAsync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {});
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
}

/** Kill every browser still holding a profile whose owning runner is dead, then
 *  drop the profile (unless E2E_KEEP_PROFILE=1 is holding it for a post-mortem).
 *  Returns how many processes were killed - the caller logs it. */
async function reapOrphanBrowsers(): Promise<number> {
  const orphans = await orphanProfileDirs();
  // The profile path is a mkdtemp name, so a BROWSER whose command line carries
  // it is unambiguously one this suite launched. Match both separators: the
  // launch argument echoes whatever the platform handed over.
  const needles = orphans.flatMap((dir) => [dir, dir.replace(/\\/g, "/")]);
  const browsers = (await listProcesses()).filter((p) => isBrowserProcess(p.cmd));
  const victims = browsers.filter((p) => needles.some((needle) => p.cmd.includes(needle)) || (isPlaywrightManaged(p.cmd) && isOrphanedByParent(p.ppid)));
  // Parents first: /T on the root usually takes the content processes, and a pid
  // already gone by then just fails harmlessly.
  for (const victim of victims) await killTree(victim.pid);

  if (process.env.E2E_KEEP_PROFILE !== "1") {
    for (const dir of orphans) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return victims.length;
}

// Playwright calls the default export for both globalSetup and globalTeardown;
// Vitest wants the same job under `setup`/`teardown` (vitest.browser.config.ts).
// Housekeeping must never be what fails a suite: a throw in globalSetup aborts
// the run before a single test executes, and no phantom process is worth that.
export default async function reap(): Promise<void> {
  try {
    const killed = await reapOrphanBrowsers();
    if (killed > 0) console.log(`[reaper] killed ${killed} orphaned browser process(es) from a run that did not shut down`);
  } catch (e) {
    console.warn(`[reaper] skipped: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export const setup = reap;
export const teardown = reap;
