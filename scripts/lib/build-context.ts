// SPDX-License-Identifier: GPL-3.0-or-later
//
// The build half of the packaged-build measurement. Two artifacts, and the boundary
// between them is the point: build-context.json goes INSIDE the output directory,
// <recordDir>/<target>/<id>.json stays OUTSIDE it and must never ship to a client.
//
// The id covers the file list and their sizes, so it exists before the digest does:
// the index is one of the files being measured and has to name its own build.

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { BUILD_INDEX_PATH, hashText, measureBuild, parseBuildIndex } from "../../src/shared/build-context";

export async function writeBuildContext(outDir: string, recordDir: string, target: string, version: string): Promise<void> {
  const files: string[] = [];
  for (const entry of await readdir(outDir, { recursive: true, withFileTypes: true })) {
    // Measured as its target's bytes here and as something else once installed.
    if (entry.isSymbolicLink()) throw new Error("Build context does not support symlinks");
    if (!entry.isFile()) continue;
    const path = relative(outDir, join(entry.parentPath, entry.name)).replaceAll("\\", "/");
    if (path !== BUILD_INDEX_PATH) files.push(path);
  }
  files.sort();
  const sizes: [string, number][] = [];
  for (const path of files) sizes.push([path, (await stat(join(outDir, path))).size]);
  const id = await hashText(JSON.stringify([1, target, version, sizes]));
  const index = parseBuildIndex({ format: 1, id, files: [...files, BUILD_INDEX_PATH].sort() });
  await writeFile(join(outDir, BUILD_INDEX_PATH), `${JSON.stringify(index)}\n`);
  const root = await measureBuild(index, async (path) => new Uint8Array(await readFile(join(outDir, path))));
  const destination = join(recordDir, target, `${id}.json`);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, `${JSON.stringify({ format: 1, id, root, target, version }, null, 2)}\n`);
}
