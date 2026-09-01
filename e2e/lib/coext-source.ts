// SPDX-License-Identifier: GPL-3.0-or-later
//
// Resolve a coexistence-test "extension source" to a local UNPACKED extension
// folder, downloading + unpacking on demand (cached). A source is one of:
//   - a local path to an already-unpacked folder (has manifest.json);
//   - a direct .zip / .crx URL (GitHub release asset - the most reliable form),
//     which MUST carry a `#sha256=<hex>` content pin (see requirePinnedUrl);
//   - a Chrome Web Store URL or a bare 32-char extension id (downloaded as a
//     .crx via the update endpoint).
// No new npm dependency: download uses Node's fetch, unzip the system bsdtar
// (Windows System32 / macOS libarchive).

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { EXTENSION_ROOT } from "./auth-signin";

interface ResolvedCoext {
  dir: string;
  label: string;
}

// A high prodversion so the Web Store update endpoint serves the current build
// (a stale/low value returns an empty 204 - verified).
const CWS_PRODVERSION = "9999.0";
const EXTENSION_ID_RE = /^[a-p]{32}$/;
const ZIP_LOCAL_FILE_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"

// Parse `E2E_COEXT_SOURCES` (URLs / store ids) + `E2E_COEXT_PATHS` /
// `E2E_COEXT_PATH` (local folders), all `;`-separated, into one source list.
export function configuredCoextSources(): string[] {
  const raw = [process.env.E2E_COEXT_SOURCES ?? "", process.env.E2E_COEXT_PATHS ?? "", process.env.E2E_COEXT_PATH ?? ""].join(";");
  return raw
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
}

// A source may carry a `#sha256=<64 hex>` content pin. Split it off before the
// ref is parsed as an id / URL / path, so every consumer below sees the bare ref.
const SHA256_PIN_RE = /#sha256=([0-9a-f]{64})$/i;

export function parseCoextSource(source: string): { ref: string; sha256: string | null } {
  const match = SHA256_PIN_RE.exec(source);
  if (!match?.[1]) return { ref: source, sha256: null };
  return { ref: source.slice(0, match.index), sha256: match[1].toLowerCase() };
}

// A stable, human-recognizable label BEFORE download (the manifest name isn't
// known yet): the store id, or the URL's file/detail slug, or the folder name.
export function sourceLabel(source: string): string {
  const { ref } = parseCoextSource(source);
  const id = extractExtensionId(ref);
  if (id) return id;
  try {
    const url = new URL(ref);
    const last = url.pathname.split("/").filter(Boolean).pop();
    if (last) return decodeURIComponent(last).replace(/\.(crx|zip)$/i, "");
  } catch {
    /* not a URL - fall through to basename */
  }
  return ref.split(/[/\\]/).filter(Boolean).pop() ?? ref;
}

export async function resolveCoextDir(source: string): Promise<ResolvedCoext> {
  const { ref, sha256 } = parseCoextSource(source);
  const localDir = resolve(ref);
  if (existsSync(join(localDir, "manifest.json"))) {
    return { dir: localDir, label: manifestName(localDir) ?? sourceLabel(source) };
  }
  requirePinnedUrl(ref, sha256);

  // Remote source - download into a per-source cache dir (keyed by the
  // source string), unpack once, and reuse it on later runs.
  const cacheRoot = resolve(EXTENSION_ROOT, ".playwright", "coext-cache");
  const dir = join(cacheRoot, createHash("sha1").update(source).digest("hex").slice(0, 16));
  await pruneStaleCacheEntries(cacheRoot, dir);
  const alreadyUnpacked = findManifestDir(dir);
  if (alreadyUnpacked) {
    // Reuse is read-only, so stamp the entry: mtime is the only "last used"
    // signal the prune above has.
    await utimes(dir, new Date(), new Date()).catch(() => {});
    return { dir: alreadyUnpacked, label: manifestName(alreadyUnpacked) ?? sourceLabel(source) };
  }

  // Download and verify BEFORE touching the cache dir, so a source that fails
  // its pin leaves nothing behind under its key.
  const raw = Buffer.from(await fetchBytes(toDownloadUrl(ref)));
  verifyDigest(ref, raw, sha256);

  await rm(dir, { recursive: true, force: true }).catch(() => {});
  await mkdir(dir, { recursive: true });

  const zip = toZipBytes(raw);
  const zipPath = join(dir, "package.zip");
  await writeFile(zipPath, zip);
  unzip(zipPath, dir);
  await rm(zipPath, { force: true }).catch(() => {});
  // A Web Store .crx carries a `_metadata` folder that can block unpacked
  // loading; Chrome regenerates any it needs, so drop the shipped one.
  await rm(join(dir, "_metadata"), { recursive: true, force: true }).catch(() => {});

  const manifestDir = findManifestDir(dir);
  if (!manifestDir) {
    throw new Error(`Downloaded ${source} but found no manifest.json under ${dir} after unpacking - is the URL an extension .zip/.crx?`);
  }
  return { dir: manifestDir, label: manifestName(manifestDir) ?? sourceLabel(source) };
}

// These archives are loaded into a browser as unpacked extensions, so a moved
// release tag or a re-uploaded asset would run new third-party code on the
// machine doing the run. A direct URL CAN be content-pinned, so it must be:
// missing pin => refuse rather than download. A Web Store id resolves to
// whatever build the store serves today and cannot be pinned at all - it is
// allowed, loudly, because there is no pinnable form of it.
function requirePinnedUrl(ref: string, sha256: string | null): void {
  if (sha256 || extractExtensionId(ref)) {
    if (!sha256) console.warn(`[coext] ${sourceLabel(ref)}: Chrome Web Store source cannot be content-pinned - whatever the store serves today is what gets loaded.`);
    return;
  }
  if (!/^https?:\/\//i.test(ref)) return; // a bad ref: toDownloadUrl names it better
  throw new Error(`Coexistence source ${ref} has no content pin. Append "#sha256=<hex>" (compute it with: curl -sL "${ref}" | sha256sum).`);
}

// Fail closed on a mismatch: the bytes are not the reviewed ones, so nothing is
// unpacked and nothing is cached under this source's key.
function verifyDigest(ref: string, raw: Buffer, expected: string | null): void {
  if (!expected) return;
  const actual = createHash("sha256").update(raw).digest("hex");
  if (actual !== expected) {
    throw new Error(`Coexistence source ${ref} failed its content pin: expected sha256 ${expected}, got ${actual}. Re-verify the asset before updating the pin.`);
  }
}

// Entries are keyed by the SOURCE STRING, so editing an E2E_COEXT_SOURCES URL
// orphans the extension unpacked under the old key forever - and these are
// hundreds of MB each. Drop entries no run has touched in a week (`keepDir` is
// this run's own, and reuse stamps it above). Best-effort, like
// makeRunProfileDir in browser-session.ts: a locked dir never blocks the run.
const CACHE_ENTRY_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_ENTRY_NAME_RE = /^[0-9a-f]{16}$/;

async function pruneStaleCacheEntries(cacheRoot: string, keepDir: string): Promise<void> {
  const cutoffMs = Date.now() - CACHE_ENTRY_MAX_AGE_MS;
  for (const entry of readdirSyncSafe(cacheRoot)) {
    if (!CACHE_ENTRY_NAME_RE.test(entry)) continue;
    const dir = join(cacheRoot, entry);
    if (dir === keepDir) continue;
    const info = await stat(dir).catch(() => null);
    if (info && info.mtimeMs < cutoffMs) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function extractExtensionId(source: string): string | null {
  if (EXTENSION_ID_RE.test(source)) return source;
  try {
    const url = new URL(source);
    const host = url.hostname;
    if (host === "chromewebstore.google.com" || host === "chrome.google.com") {
      const idFromPath = url.pathname.split("/").find((seg) => EXTENSION_ID_RE.test(seg));
      if (idFromPath) return idFromPath;
    }
  } catch {
    /* not a URL */
  }
  return null;
}

function toDownloadUrl(source: string): string {
  const id = extractExtensionId(source);
  if (id) {
    const x = encodeURIComponent(`id=${id}&uc`);
    return `https://clients2.google.com/service/update2/crx?response=redirect&acceptformat=crx2,crx3&prodversion=${CWS_PRODVERSION}&x=${x}`;
  }
  if (/^https?:\/\//i.test(source)) return source;
  throw new Error(`Unrecognized coexistence source "${source}" - expected a local unpacked folder, a .zip/.crx URL, a Chrome Web Store URL, or a 32-char extension id.`);
}

async function fetchBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`Download failed for ${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0) throw new Error(`Download for ${url} returned an empty body (the Web Store update endpoint does this for an unknown id / too-low prodversion).`);
  return buf;
}

// A .crx is a header + an embedded zip; a plain .zip already starts at the
// signature. Slicing from the first local-file signature yields a valid zip in
// both cases (and for both crx2 and crx3).
function toZipBytes(raw: Buffer): Buffer {
  if (raw.subarray(0, 4).toString("latin1") !== "Cr24") return raw;
  const start = raw.indexOf(ZIP_LOCAL_FILE_SIGNATURE);
  if (start < 0) throw new Error("Downloaded a .crx but found no embedded zip payload.");
  return raw.subarray(start);
}

function unzip(zipPath: string, destDir: string): void {
  const result = spawnSync(bsdtarPath(), ["-xf", zipPath, "-C", destDir], { encoding: "utf8" });
  if (result.status !== 0) {
    const detail = (result.stderr || result.error?.message || "").trim();
    throw new Error(`Failed to unpack ${zipPath} with bsdtar (${detail || `exit ${result.status}`}). Need bsdtar/libarchive (Windows System32 tar, macOS tar).`);
  }
}

// GNU tar does not read zip; bsdtar/libarchive does. On Windows that means the
// System32 `tar.exe` explicitly, because git-bash's `tar` on PATH is GNU tar.
// Elsewhere the plain `tar` is taken, which is libarchive on macOS - on a distro
// shipping GNU tar the throw above names bsdtar as what is missing.
function bsdtarPath(): string {
  if (process.platform === "win32") {
    return join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
  }
  return "tar";
}

// The manifest may sit at the root or up to 3 levels down (some release zips
// nest folders). Return the shallowest directory that contains a manifest.json.
function findManifestDir(root: string): string | null {
  if (existsSync(join(root, "manifest.json"))) return root;
  const hit = findManifestFile(root, 3);
  return hit ? dirname(hit) : null;
}

function findManifestFile(dir: string, depth: number): string | null {
  if (depth < 0 || !existsSync(dir)) return null;
  const direct = join(dir, "manifest.json");
  if (existsSync(direct)) return direct;
  const entries = readdirSyncSafe(dir);
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const child = join(dir, entry);
    if (isDirSafe(child)) {
      const found = findManifestFile(child, depth - 1);
      if (found) return found;
    }
  }
  return null;
}

function manifestName(dir: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { name?: string };
    if (manifest.name && !manifest.name.startsWith("__MSG_")) return manifest.name;
  } catch {
    /* fall through */
  }
  return null;
}

// Sync is fine: the manifest walk runs once, at test setup.
function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}
function isDirSafe(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// Exposed for the self-check spec (e2e/coext-source.spec.ts).
export const __testables = { toZipBytes, extractExtensionId, toDownloadUrl, parseCoextSource, requirePinnedUrl, verifyDigest };
