// SPDX-License-Identifier: GPL-3.0-or-later
//
// What a unit test cannot reach: whether the browser permits the background to read
// back every file its own package carries. The digest is not asserted here - the build
// step and the background call the same `measureBuild`.
import { glob, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { BUILD_INDEX_PATH } from "../src/shared/build-context";
import * as ext from "./lib/extension";

test("the background can read every file its package carries, and the package names a registered build", async () => {
  test.skip(ext.isFirefoxRun(), "the Firefox build is installed as a temporary add-on from the same directory - the Chromium run covers the package read");

  // The harness runs from a snapshot copy, which has no record beside it.
  const index = JSON.parse(await readFile(resolve(ext.resolveExtensionPath(), BUILD_INDEX_PATH), "utf8"));
  const records = await Array.fromAsync(glob(`*/${index.id}.json`, { cwd: resolve(ext.EXTENSION_ROOT, ".output", "build-records") }));
  expect(records, `no build record for ${index.id} - rebuild before running this`).toHaveLength(1);

  // Written outside the package.
  const record = JSON.parse(await readFile(resolve(ext.EXTENSION_ROOT, ".output", "build-records", records[0] ?? ""), "utf8"));
  expect(record).toMatchObject({ format: 1, id: index.id, root: expect.stringMatching(/^[a-f0-9]{64}$/) });

  const session = await ext.launchSession();
  try {
    await (await session.context.newPage()).goto("about:blank");
    const read = await ext.evalInBackground(
      session.context,
      async (paths: string[]) => {
        const api = (globalThis as { browser?: typeof browser }).browser ?? (chrome as unknown as typeof browser);
        const failed: string[] = [];
        let bytes = 0;
        for (const path of paths) {
          const response = await fetch(api.runtime.getURL(path), { cache: "no-store" });
          if (!response.ok) failed.push(path);
          else bytes += (await response.arrayBuffer()).byteLength;
        }
        return { failed, bytes };
      },
      index.files as string[],
    );

    expect(read.failed).toEqual([]);
    expect(read.bytes).toBeGreaterThan(0);
  } finally {
    await ext.closeSession(session);
  }
});
