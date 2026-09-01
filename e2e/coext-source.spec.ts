// SPDX-License-Identifier: GPL-3.0-or-later
//
// Self-check for the pure source-resolution logic in lib/coext-source (source
// classification + crx-to-zip slicing). Runs in every `test:e2e` - no browser, no
// network, so it always executes even when the coexistence downloads are off.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { parse as parseDotenv } from "dotenv";
import { __testables } from "./lib/coext-source";

const { toZipBytes, extractExtensionId, toDownloadUrl, parseCoextSource, requirePinnedUrl, verifyDigest } = __testables;
const ADBLOCK_ID = "gighmmpiobklfepjocnamgkkbiglidom";
const RELEASE_ZIP = "https://github.com/x/y/releases/download/v1/ext.zip";

test("crx payload is sliced from the first zip signature; a plain zip passes through", () => {
  const zipBody = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x11, 0x22]); // PK\x03\x04 + data
  const crx = Buffer.concat([Buffer.from("Cr24", "latin1"), Buffer.from([3, 0, 0, 0, 4, 0, 0, 0]), Buffer.from("HDR!", "latin1"), zipBody]);
  expect(toZipBytes(crx).equals(zipBody)).toBe(true);
  expect(toZipBytes(zipBody).equals(zipBody)).toBe(true);
});

test("extension id is recognized bare and inside a Web Store URL, not in a GitHub URL", () => {
  expect(extractExtensionId(ADBLOCK_ID)).toBe(ADBLOCK_ID);
  expect(extractExtensionId(`https://chromewebstore.google.com/detail/adblock/${ADBLOCK_ID}`)).toBe(ADBLOCK_ID);
  expect(extractExtensionId("https://github.com/x/y/releases/download/v1/ext.zip")).toBeNull();
});

test("download URL: store id -> CWS crx endpoint; direct zip -> as-is; junk -> throws", () => {
  expect(toDownloadUrl(ADBLOCK_ID)).toContain("clients2.google.com/service/update2/crx");
  expect(toDownloadUrl(ADBLOCK_ID)).toContain(encodeURIComponent(`id=${ADBLOCK_ID}&uc`));
  expect(toDownloadUrl(RELEASE_ZIP)).toBe(RELEASE_ZIP);
  expect(() => toDownloadUrl("not a url or id")).toThrow();
});

test("the content pin splits off the ref and survives a store id / local path", () => {
  const hex = "a".repeat(64);
  expect(parseCoextSource(`${RELEASE_ZIP}#sha256=${hex}`)).toEqual({ ref: RELEASE_ZIP, sha256: hex });
  expect(parseCoextSource(`${RELEASE_ZIP}#sha256=${hex.toUpperCase()}`).sha256).toBe(hex);
  expect(parseCoextSource(RELEASE_ZIP)).toEqual({ ref: RELEASE_ZIP, sha256: null });
  // Not a pin: wrong length, so the whole string stays the ref.
  expect(parseCoextSource(`${RELEASE_ZIP}#sha256=abc`).ref).toBe(`${RELEASE_ZIP}#sha256=abc`);
  expect(parseCoextSource(ADBLOCK_ID)).toEqual({ ref: ADBLOCK_ID, sha256: null });
});

test("an unpinned direct URL is refused; a store id is allowed unpinned", () => {
  expect(() => requirePinnedUrl(RELEASE_ZIP, null)).toThrow(/no content pin/);
  expect(() => requirePinnedUrl(RELEASE_ZIP, "a".repeat(64))).not.toThrow();
  expect(() => requirePinnedUrl(ADBLOCK_ID, null)).not.toThrow();
});

// The shipped list is one long line whose every direct URL ends in a `#sha256=`
// pin - and dotenv reads an unquoted `#` as the start of a comment. Unquoted, it
// truncated 7 sources to 1 unpinned URL, so the suite generated a single test
// that the pin guard failed in 5 ms and the other 6 extensions were never loaded.
// The value must stay quoted; this reads the file the way a run does.
test("the shipped coexistence source list survives dotenv parsing with every pin intact", () => {
  const envExample = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".env.e2e.example");
  const value = parseDotenv(readFileSync(envExample, "utf8")).E2E_COEXT_SOURCES ?? "";
  const sources = value
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  expect(sources.length, "a default list that collapses to one source means the value lost its quotes").toBeGreaterThan(1);
  for (const source of sources) {
    const { ref, sha256 } = parseCoextSource(source);
    if (!/^https?:\/\//i.test(ref)) continue; // a Web Store id has no pinnable form
    expect(sha256, `${ref} carries no #sha256 pin, so the run would refuse it`).not.toBeNull();
  }
});

test("a digest mismatch fails closed; the matching digest passes", () => {
  const bytes = Buffer.from("extension payload");
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(() => verifyDigest(RELEASE_ZIP, bytes, digest)).not.toThrow();
  expect(() => verifyDigest(RELEASE_ZIP, bytes, "b".repeat(64))).toThrow(/failed its content pin/);
  expect(() => verifyDigest(RELEASE_ZIP, bytes, null)).not.toThrow();
});
