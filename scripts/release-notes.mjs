// @ts-check
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Usage: node scripts/release-notes.mjs <version> [output]

import { readFileSync, writeFileSync } from "node:fs";
import { buildReleaseNotes } from "./lib/release-notes.mjs";

const [version, output = "release-notes.md"] = process.argv.slice(2);

if (!version) {
  console.error("Usage: node scripts/release-notes.mjs <version> [output]");
  process.exit(1);
}

writeFileSync(output, `${buildReleaseNotes(readFileSync("CHANGELOG.md", "utf8"), version)}\n`);
