// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";
import { installFakeChrome } from "../test/fixtures";
import { clientSecurityHeaders, getClientSecurityContext } from "./client-security";

let localStore: Record<string, unknown> = {};

beforeEach(() => {
  localStore = installFakeChrome().local;
});

describe("client security context", () => {
  it("creates one install id and keeps it", async () => {
    const first = await getClientSecurityContext();
    const second = await getClientSecurityContext();

    expect(first.installId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(second).toEqual(first);
  });

  it("emits the x-emojery-install-id request header and nothing else", async () => {
    const headers = await clientSecurityHeaders();

    expect(Object.keys(headers)).toEqual(["x-emojery-install-id"]);
    expect(headers["x-emojery-install-id"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("drops the session fields an older build stored, keeping the install id", async () => {
    localStore.security_context_v1 = { installId: "install_1234567890abcdef", sessionId: "session_1234567890abcdef", sessionStartedAt: 1000 };

    const ctx = await getClientSecurityContext();

    expect(ctx).toEqual({ installId: "install_1234567890abcdef" });
    expect(localStore.security_context_v1).toEqual({ installId: "install_1234567890abcdef" });
  });
});

// storage.local is not a trusted store: an older build, a synced profile or a hand-edited one
// can leave anything under this key, and the id goes straight out as a request header. The
// readback rejects whatever the generator could not have produced and mints a fresh id, so a
// stored value only ever survives if it already matches the shape.
describe("stored ids are re-validated on read, not trusted", () => {
  const GOOD = "install_1234567890abcdef";

  // Each one is a value randomId() cannot emit.
  const malformed: Array<[string, unknown]> = [
    ["one char short of the minimum", "a".repeat(15)],
    ["one char past the maximum", "a".repeat(129)],
    ["empty", ""],
    ["blank", "   "],
    ["a path separator", "install/1234567890abcd"],
    ["a header separator", "install\r\nx-injected: 1"],
    ["a space inside", "install 1234567890abcd"],
    ["a non-ASCII letter", "instаll_1234567890abcdef"],
    ["a number", 1234567890123456],
    ["an object", { id: GOOD }],
    ["null", null],
    ["an array", [GOOD]],
  ];

  for (const [label, stored] of malformed) {
    it(`replaces an install id stored as ${label}`, async () => {
      localStore.security_context_v1 = { installId: stored };

      const ctx = await getClientSecurityContext();

      expect(ctx.installId).not.toEqual(stored);
      expect(ctx.installId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      // ...and the replacement is persisted, so the next read is not asked to judge it again.
      expect((localStore.security_context_v1 as { installId: string }).installId).toBe(ctx.installId);
    });
  }

  it("never lets a rejected value reach the request headers", async () => {
    localStore.security_context_v1 = { installId: "install\r\nx-injected: 1" };

    const headers = await clientSecurityHeaders();

    expect(headers["x-emojery-install-id"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("keeps a stored id that already has the shape, at either length bound", async () => {
    for (const id of ["a".repeat(16), "a".repeat(128), "A-Za-z0-9_-0123456789"]) {
      localStore.security_context_v1 = { installId: id };
      const ctx = await getClientSecurityContext();
      expect(ctx.installId, id).toBe(id);
    }
  });

  it("accepts a padded id by trimming it rather than minting a new installation", async () => {
    localStore.security_context_v1 = { installId: `  ${GOOD}\n` };
    const ctx = await getClientSecurityContext();
    expect(ctx.installId).toBe(GOOD);
    // The trimmed form is what gets persisted, so the padding is not judged again.
    expect(localStore.security_context_v1).toEqual({ installId: GOOD });
  });
});
