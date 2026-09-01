// SPDX-License-Identifier: GPL-3.0-or-later
//
// The id behind the optimistic history row and the client-security install/session
// headers. The contract that matters is the one background/client-security.ts reads
// back: /^[A-Za-z0-9_-]{16,128}$/. Each generator branch is pinned against it, because
// the fallbacks only ever run where the branch above them is missing - which is exactly
// where nobody looks until a stored id fails validation.

import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./random-id";

// The readback validation in background/client-security.ts, verbatim.
const STORED_ID_RE = /^[A-Za-z0-9_-]{16,128}$/;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("randomId", () => {
  it("uses crypto.randomUUID where the platform has it", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    vi.stubGlobal("crypto", { randomUUID });

    const id = randomId();
    expect(id).toBe("11111111-2222-4333-8444-555555555555");
    expect(id).toMatch(STORED_ID_RE);
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it("falls back to getRandomValues as full-width hex", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        // A leading zero byte is the case padStart exists for: unpadded it would
        // shorten the id, and a short enough one fails the readback pattern.
        bytes.fill(0xab);
        bytes[0] = 0x00;
        return bytes;
      },
    });

    const id = randomId();
    expect(id).toBe(`00${"ab".repeat(15)}`);
    expect(id).toHaveLength(32);
    expect(id).toMatch(STORED_ID_RE);
  });

  it("throws rather than mint a guessable id when there is no Web Crypto at all", () => {
    vi.stubGlobal("crypto", undefined);
    // This id also becomes the install/session header the API reads, so a
    // predictable one is worth more to an attacker than a missing one.
    expect(() => randomId()).toThrow(/no Web Crypto/);
  });

  it("throws the same way when `crypto` exists but carries neither generator", () => {
    // A stripped environment, not a browser: the object is there, the two methods
    // are not, and the branch that skips BOTH of them is the one no other case walks.
    vi.stubGlobal("crypto", {});
    expect(() => randomId()).toThrow(/no Web Crypto/);
  });

  it("lets the API layer send a request without the client-security headers instead of a guessable one", async () => {
    // The one caller that must not become a hard failure: jsonApiHeaders absorbs it.
    vi.stubGlobal("crypto", undefined);
    const { jsonApiHeaders } = await import("../background/identity");
    const headers = await jsonApiHeaders({});
    expect(headers["x-emojery-install-id"]).toBeUndefined();
    expect(headers["x-emojery-session-id"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  it("does not repeat itself", () => {
    const ids = new Set(Array.from({ length: 200 }, () => randomId()));
    expect(ids.size).toBe(200);
  });
});
