// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";
import { installFakeChrome } from "../test/fixtures";
import { clientSecurityHeaders, getClientSecurityContext, SESSION_TTL_MS } from "./client-security";

let localStore: Record<string, unknown> = {};

beforeEach(() => {
  localStore = installFakeChrome().local;
});

describe("client security context", () => {
  it("creates stable install and session ids", async () => {
    const first = await getClientSecurityContext(1000);
    const second = await getClientSecurityContext(2000);

    expect(first.installId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(first.sessionId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(second).toEqual(first);
  });

  it("rotates the session id while preserving install id", async () => {
    localStore.security_context_v1 = {
      installId: "install_1234567890abcdef",
      sessionId: "session_1234567890abcdef",
      sessionStartedAt: 1000,
    };

    // One tick short of the TTL still holds the session; the TTL itself rotates it.
    const held = await getClientSecurityContext(1000 + SESSION_TTL_MS - 1);
    expect(held.sessionId).toBe("session_1234567890abcdef");

    const next = await getClientSecurityContext(1000 + SESSION_TTL_MS);

    expect(next.installId).toBe("install_1234567890abcdef");
    expect(next.sessionId).not.toBe("session_1234567890abcdef");
  });

  it("emits the x-emojery-install-id and x-emojery-session-id request headers", async () => {
    const headers = await clientSecurityHeaders();

    expect(headers["x-emojery-install-id"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(headers["x-emojery-session-id"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });
});

// storage.local is not a trusted store: an older build, a synced profile or a hand-edited one
// can leave anything under this key, and both ids go straight out as request headers. The
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
      localStore.security_context_v1 = { installId: stored, sessionId: GOOD, sessionStartedAt: 1000 };

      const ctx = await getClientSecurityContext(1000);

      expect(ctx.installId).not.toEqual(stored);
      expect(ctx.installId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      // ...and the replacement is persisted, so the next read is not asked to judge it again.
      expect((localStore.security_context_v1 as { installId: string }).installId).toBe(ctx.installId);
    });

    it(`replaces a session id stored as ${label}`, async () => {
      localStore.security_context_v1 = { installId: GOOD, sessionId: stored, sessionStartedAt: 1000 };

      const ctx = await getClientSecurityContext(1000);

      expect(ctx.sessionId).not.toEqual(stored);
      expect(ctx.sessionId).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
      // The install id is judged separately: one bad field does not reset the installation.
      expect(ctx.installId).toBe(GOOD);
    });
  }

  it("never lets a rejected value reach the request headers", async () => {
    localStore.security_context_v1 = { installId: "install\r\nx-injected: 1", sessionId: "s", sessionStartedAt: 1000 };

    const headers = await clientSecurityHeaders();

    expect(headers["x-emojery-install-id"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
    expect(headers["x-emojery-session-id"]).toMatch(/^[A-Za-z0-9_-]{16,128}$/);
  });

  it("keeps a stored id that already has the shape, at either length bound", async () => {
    for (const id of ["a".repeat(16), "a".repeat(128), "A-Za-z0-9_-0123456789"]) {
      localStore.security_context_v1 = { installId: id, sessionId: id, sessionStartedAt: 1000 };
      const ctx = await getClientSecurityContext(1000);
      expect(ctx.installId, id).toBe(id);
      expect(ctx.sessionId, id).toBe(id);
    }
  });

  it("accepts a padded id by trimming it rather than minting a new installation", async () => {
    localStore.security_context_v1 = { installId: `  ${GOOD}\n`, sessionId: GOOD, sessionStartedAt: 1000 };
    expect((await getClientSecurityContext(1000)).installId).toBe(GOOD);
  });

  // A session with no start time cannot be aged out, so it is not a session - the TTL is the
  // only thing that bounds how long one id follows a user around.
  it("mints a new session when the stored start time is missing or not a number", async () => {
    for (const sessionStartedAt of [undefined, 0, -1, "1000", Number.NaN, Number.POSITIVE_INFINITY]) {
      localStore.security_context_v1 = { installId: GOOD, sessionId: "session_1234567890abcdef", sessionStartedAt };
      const ctx = await getClientSecurityContext(1000);
      expect(ctx.sessionId, String(sessionStartedAt)).not.toBe("session_1234567890abcdef");
    }
  });
});
