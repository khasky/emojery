// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared .env loader for the e2e configs. Both the Playwright config and the
// site-auth Vitest config read the SAME ordered set of dotenv files; this is the
// single implementation they call so the file list stays in lockstep. Each
// config still owns its own "shell env wins" merge, which differs slightly.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { config as loadDotenv } from "dotenv";

const DEFAULT_ENV_FILES = [".env.e2e.example", ".env", ".env.local", ".env.e2e", ".env.e2e.local"];

// Read each file into `collected`, later files overriding earlier, skipping
// empty values so a present-but-blank key never clobbers a real one.
function loadEnvFileSet(paths: string[], collected: Record<string, string>): void {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const fileEnv: Record<string, string> = {};
    loadDotenv({ path, processEnv: fileEnv, override: true, quiet: true });
    for (const [key, value] of Object.entries(fileEnv)) {
      if (value === "") continue;
      collected[key] = value;
    }
  }
}

// Collect the default e2e dotenv set (plus an optional E2E_ENV_FILE) relative
// to `extensionRoot`. Returns only the file-sourced values; the caller decides
// how to merge them with process.env.
export function loadE2eEnvFiles(extensionRoot: string): Record<string, string> {
  const collected: Record<string, string> = {};
  loadEnvFileSet(
    DEFAULT_ENV_FILES.map((file) => resolve(extensionRoot, file)),
    collected,
  );
  const extra = process.env.E2E_ENV_FILE || collected.E2E_ENV_FILE;
  if (extra) loadEnvFileSet([resolve(extensionRoot, extra)], collected);
  return collected;
}
