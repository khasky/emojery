// SPDX-License-Identifier: GPL-3.0-or-later
//
// The packaged-build measurement, shared by the build step and the background.
// The result says which build's files answered. It does not identify the client, and
// nothing may be gated on it.

export const BUILD_INDEX_PATH = "build-context.json";
export const BUILD_ID_HEADER = "x-emojery-build-id";
export const BUILD_TAG_HEADER = "x-emojery-build-tag";
export const BUILD_REF_HEADER = "x-emojery-build-ref";

export interface BuildIndex {
  format: 1;
  id: string;
  files: string[];
}

// The index ships inside the package, so a hand-edited install can say anything here.
export function parseBuildIndex(value: unknown): BuildIndex {
  const index = value as Partial<BuildIndex> | null;
  if (index?.format !== 1 || typeof index.id !== "string" || !/^[a-f0-9]{64}$/.test(index.id) || !Array.isArray(index.files)) throw new Error("Invalid build index");
  const files = index.files;
  if (files.length < 2 || files.length > 2048 || !files.includes(BUILD_INDEX_PATH) || !files.includes("manifest.json")) throw new Error("Invalid build files");
  for (let i = 0; i < files.length; i++) {
    const path = files[i];
    // Strictly ascending: the build step's hashing order, and no file twice.
    if (typeof path !== "string" || path.length > 256 || !/^[A-Za-z0-9_./-]+$/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..") || (i > 0 && path <= (files[i - 1] ?? ""))) {
      throw new Error("Invalid build path");
    }
  }
  return index as BuildIndex;
}

function sortedJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortedJson(item)]),
    );
  }
  return value;
}

// Chrome stamps `key`, `update_url` and `differential_fingerprint` into manifest.json
// when it packages the extension, and may reorder the rest.
export function measuredBytes(path: string, bytes: Uint8Array): Uint8Array {
  if (path !== "manifest.json") return bytes;
  const manifest = JSON.parse(new TextDecoder().decode(bytes));
  delete manifest.key;
  delete manifest.update_url;
  delete manifest.differential_fingerprint;
  return new TextEncoder().encode(JSON.stringify(sortedJson(manifest)));
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash), (n) => n.toString(16).padStart(2, "0")).join("");
}

export function hashText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

/** The digest over every file the index names, in index order. */
export async function measureBuild(index: BuildIndex, read: (path: string) => Promise<Uint8Array>): Promise<string> {
  const entries: [string, string][] = [];
  let total = 0;
  for (const path of index.files) {
    const bytes = await read(path);
    total += bytes.byteLength;
    if (bytes.byteLength > 16 * 1024 * 1024 || total > 64 * 1024 * 1024) throw new Error("Build size exceeded");
    entries.push([path, await sha256Hex(measuredBytes(path, bytes))]);
  }
  return hashText(JSON.stringify(entries));
}

// What the server recomputes. One value is good for one request shape, until the ref
// it was built on expires.
export async function buildRequestTag(id: string, root: string, ref: string, url: string, method: string, authorization: string): Promise<string> {
  return hashText(JSON.stringify(["emojery-build-v1", id, root, ref, new URL(url).href, method, await hashText(authorization)]));
}

// `<version>.<payload base64url>.<mac hex>`, a shape of its own so a session token can
// never be presented in its place or the reverse. The mac is the server's to check.
export function buildRefExpiryMs(ref: string): number | null {
  const payload = ref.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(atob(payload.replaceAll("-", "+").replaceAll("_", "/")));
    const expiresAt = claims?.exp * 1000;
    return Number.isSafeInteger(expiresAt) ? expiresAt : null;
  } catch {
    return null;
  }
}
