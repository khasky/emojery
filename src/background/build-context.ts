// SPDX-License-Identifier: GPL-3.0-or-later
//
// The client half of the build measurement; shared/build-context.ts says what the
// result shows. Nothing here issues a request of its own, and no API call waits on it.

import { BUILD_ID_HEADER, BUILD_INDEX_PATH, BUILD_TAG_HEADER, buildRefExpiryMs, buildRequestTag, measureBuild, parseBuildIndex } from "../shared/build-context";
import { storageSessionGet, storageSessionSet } from "../shared/webext";
import { logBackgroundError } from "./debug";

const MEASUREMENT_KEY = "build_measurement_v1";
// Stop this far short of the expiry, so an answer cannot land just after it.
const EXPIRY_MARGIN_MS = 5000;
const MAX_INDEX_BYTES = 512 * 1024;

interface StoredMeasurement {
  id?: unknown;
  root?: unknown;
}

let ref = "";
let refExpiresAt = 0;
let measurement: Promise<{ id: string; root: string } | null> | undefined;

/** Called for every API response, failures included - a client that only ever sees a
 *  refusal still needs a fresh one. */
export function rememberBuildRef(value: string | null): void {
  if (!value || value.length > 2048 || value === ref) return;
  const expiresAt = buildRefExpiryMs(value);
  // Spent, or dated far enough ahead to be another clock.
  if (expiresAt === null || expiresAt <= Date.now() + EXPIRY_MARGIN_MS || expiresAt > Date.now() + 60 * 60_000) return;
  ref = value;
  refExpiresAt = expiresAt - EXPIRY_MARGIN_MS;
  if (!measurement) measurement = measurePackage();
}

export async function buildTagHeaders(url: string, method: string, authorization: string): Promise<Record<string, string>> {
  if (!measurement || Date.now() >= refExpiresAt) return {};
  const held = ref;
  const measured = await measurement;
  // The ref may have expired or been replaced while the measurement ran.
  if (!measured || held !== ref || Date.now() >= refExpiresAt) return {};
  const tag = await buildRequestTag(measured.id, measured.root, held, url, method, authorization);
  return { [BUILD_ID_HEADER]: measured.id, [BUILD_TAG_HEADER]: `${held}~${tag}` };
}

async function measurePackage(): Promise<{ id: string; root: string } | null> {
  const getURL = globalThis.chrome?.runtime?.getURL;
  if (!getURL) return null;
  const read = async (path: string): Promise<Uint8Array> => {
    const response = await fetch(getURL(path), { cache: "no-store" });
    if (!response.ok) throw new Error(`Packaged file unavailable: ${path}`);
    return new Uint8Array(await response.arrayBuffer());
  };
  try {
    const indexBytes = await read(BUILD_INDEX_PATH);
    if (indexBytes.byteLength > MAX_INDEX_BYTES) return null;
    const index = parseBuildIndex(JSON.parse(new TextDecoder().decode(indexBytes)));

    const cached = (await storageSessionGet([MEASUREMENT_KEY]))[MEASUREMENT_KEY] as StoredMeasurement | undefined;
    if (cached?.id === index.id && typeof cached.root === "string" && /^[a-f0-9]{64}$/.test(cached.root)) {
      return { id: index.id, root: cached.root };
    }

    const root = await measureBuild(index, (path) => (path === BUILD_INDEX_PATH ? Promise.resolve(indexBytes) : read(path)));
    await storageSessionSet({ [MEASUREMENT_KEY]: { id: index.id, root } });
    return { id: index.id, root };
  } catch (error) {
    // An unpacked build has no index, and a hand-edited one can hold anything.
    logBackgroundError("buildContext.measure", error);
    return null;
  }
}

/** Test seam. */
export function resetBuildContext(): void {
  ref = "";
  refExpiresAt = 0;
  measurement = undefined;
}
