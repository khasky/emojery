// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { allowColdModuleReset } from "../test/cold-module-reset";

allowColdModuleReset();

// `__EM_DEBUG_LOG__` is a wxt.config.ts `define`, so it is undefined under Vitest
// and the module defaults the channels ON. Stubbing it false is what a production
// build compiles to, and it has to be set BEFORE the import: the module reads the
// constant once, at module scope.
async function importDebug(debugLog?: boolean) {
  vi.resetModules();
  if (debugLog !== undefined) vi.stubGlobal("__EM_DEBUG_LOG__", debugLog);
  return await import("./debug");
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("debug API logging", () => {
  it("logs API requests in a dev build without consuming the response", async () => {
    const { apiFetch } = await importDebug();
    const fetchMock = vi.fn(async () => Response.json({ ok: true, token: "secret-token" }, { status: 202 }));
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", fetchMock);

    const response = await apiFetch("https://api.test/reactions/vote?x=1", {
      method: "POST",
      body: JSON.stringify({ targetId: "t1", token: "request-token" }),
    });

    await expect(response.json()).resolves.toEqual({
      ok: true,
      token: "secret-token",
    });
    expect(info).toHaveBeenCalledWith(
      "[emojery:api]",
      expect.objectContaining({
        statusCode: 202,
        responsePayload: { ok: true, token: "[redacted]" },
        requestPayload: {
          method: "POST",
          // Path only - the query is logged in `query`, so it is dropped from the URL
          // string to keep a query value from surviving redactSensitive twice over.
          url: "https://api.test/reactions/vote",
          query: { x: "1" },
          body: { targetId: "t1", token: "[redacted]" },
        },
        execTime: expect.any(Number),
      }),
    );
  });

  it("redacts the OTP email and code from logged auth request bodies", async () => {
    const { apiFetch } = await importDebug();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true }, { status: 200 })),
    );

    await apiFetch("https://api.test/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email: "alice@example.com", code: "123456" }),
    });

    expect(info).toHaveBeenCalledWith(
      "[emojery:api]",
      expect.objectContaining({
        requestPayload: expect.objectContaining({
          body: { email: "[redacted]", code: "[redacted]" },
        }),
      }),
    );
  });

  it("logs nothing in a production build, on any channel", async () => {
    const { apiFetch, logBackgroundError, logIndexedDbDebug } = await importDebug(false);
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // Spied too, not just `info`: the error channel writes here now, so a silent
    // production build has to be proven on both methods or the assert has a hole.
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );

    await apiFetch("https://api.test/reactions/count");
    logBackgroundError("scope", new Error("boom"));
    logIndexedDbDebug("enqueue", { store: "votes" }, { id: 7 }, Date.now());

    expect(info).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("writes the error channel to console.error, so a DevTools severity filter shows it", async () => {
    const { logBackgroundError } = await importDebug();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logBackgroundError("drainQueuedVotes", new Error("boom"));

    expect(error).toHaveBeenCalledWith("[emojery:error]", { scope: "drainQueuedVotes", message: "boom" });
    // The whole point: it must NOT land at info, where an Errors-only filter hides it.
    expect(info).not.toHaveBeenCalled();
  });

  it("keeps the api and indexeddb channels at console.info", async () => {
    const { logIndexedDbDebug } = await importDebug();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    logIndexedDbDebug("peekNext", { store: "votes" }, { id: 1 }, Date.now());

    expect(info).toHaveBeenCalledWith("[emojery:indexeddb]", expect.anything());
    expect(error).not.toHaveBeenCalled();
  });

  it("redacts the failure message on the apiFetch reject path, like the success path", async () => {
    const { apiFetch } = await importDebug();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // The jwt.io sample token, signed with the string "secret".
    // nosemgrep: generic.secrets.security.detected-jwt-token.detected-jwt-token
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error(jwt);
      }),
    );

    await expect(apiFetch("https://api.test/reactions/vote", { method: "POST", body: "{}" })).rejects.toThrow();

    expect(info).toHaveBeenCalledWith(
      "[emojery:api]",
      expect.objectContaining({
        statusCode: 0,
        responsePayload: { error: "[redacted]" },
      }),
    );
  });

  it("redacts renamed credential-like fields by key substring", async () => {
    const { apiFetch } = await importDebug();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ access_token: "a", refresh_token: "b", session_id: "c", api_key: "d", targetId: "t1" }, { status: 200 })),
    );

    await apiFetch("https://api.test/auth/session");

    expect(info).toHaveBeenCalledWith(
      "[emojery:api]",
      expect.objectContaining({
        responsePayload: {
          access_token: "[redacted]",
          refresh_token: "[redacted]",
          session_id: "[redacted]",
          api_key: "[redacted]",
          targetId: "t1",
        },
      }),
    );
  });

  it("redacts JWT-shaped values regardless of the key name", async () => {
    const { apiFetch } = await importDebug();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    // The jwt.io sample token, signed with the string "secret".
    // nosemgrep: generic.secrets.security.detected-jwt-token.detected-jwt-token
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: jwt, note: "eyJnot.a.jwt but text" }, { status: 200 })),
    );

    await apiFetch("https://api.test/reactions/mine");

    expect(info).toHaveBeenCalledWith(
      "[emojery:api]",
      expect.objectContaining({
        responsePayload: {
          data: "[redacted]",
          note: "eyJnot.a.jwt but text",
        },
      }),
    );
  });

  it("logs IndexedDB operations in a dev build", async () => {
    const { logIndexedDbDebug } = await importDebug();
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);

    logIndexedDbDebug("enqueue", { store: "votes", vote: { targetId: "t1" } }, { id: 7 }, Date.now());

    expect(info).toHaveBeenCalledWith(
      "[emojery:indexeddb]",
      expect.objectContaining({
        operation: "enqueue",
        requestPayload: { store: "votes", vote: { targetId: "t1" } },
        responsePayload: { id: 7 },
        execTime: expect.any(Number),
      }),
    );
  });
});
