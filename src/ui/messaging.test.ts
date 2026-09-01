// SPDX-License-Identifier: GPL-3.0-or-later
//
// The content script's one door to the background. Its whole contract is what happens when
// the trip does NOT go well: this code runs inside a hostile page, and every failure mode has
// to land on "signed out" rather than on a thrown promise or an assumed identity.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../shared/webext", () => ({ sendRuntimeMessage: vi.fn() }));

import { sendRuntimeMessage } from "../shared/webext";
import { activeUserId, authStatus, sendMessage } from "./messaging";

const AUTHED = { type: "auth:status", authed: true, userId: "u1", email: null } as const;

function reply(response: unknown): void {
  vi.mocked(sendRuntimeMessage).mockResolvedValue(response as never);
}

afterEach(() => {
  vi.mocked(sendRuntimeMessage).mockReset();
});

describe("sendMessage", () => {
  it("passes the message through and returns the background's reply", async () => {
    reply({ type: "ok" });
    await expect(sendMessage({ type: "auth:status" })).resolves.toEqual({ type: "ok" });
    expect(sendRuntimeMessage).toHaveBeenCalledWith({ type: "auth:status" });
  });

  // An MV3 worker that dies mid-message resolves `undefined` instead of rejecting, so a
  // caller reading `.type` off it would fail on the NEXT line, far from the cause.
  it("rejects rather than resolving undefined when the background answered nothing", async () => {
    reply(undefined);
    await expect(sendMessage({ type: "auth:status" })).rejects.toThrow("runtime response missing");
  });
});

describe("authStatus", () => {
  it("reports the account the background hands out", async () => {
    reply(AUTHED);
    await expect(authStatus()).resolves.toEqual({ authed: true, userId: "u1" });
  });

  // The response carries `email` too. It must not travel further than this function: the
  // caller is content-script code on a page that can read anything it is given.
  it("forwards only authed and userId, never the address", async () => {
    reply({ ...AUTHED, email: "someone@example.com" });
    expect(Object.keys(await authStatus()).sort()).toEqual(["authed", "userId"]);
  });

  it("reports signed out when the background says so", async () => {
    reply({ type: "auth:status", authed: false, userId: null, email: null });
    await expect(authStatus()).resolves.toEqual({ authed: false, userId: null });
  });

  it("falls back to signed out when the trip fails", async () => {
    vi.mocked(sendRuntimeMessage).mockRejectedValue(new Error("Extension context invalidated"));
    await expect(authStatus()).resolves.toEqual({ authed: false, userId: null });
  });

  it("falls back to signed out on an empty reply", async () => {
    reply(undefined);
    await expect(authStatus()).resolves.toEqual({ authed: false, userId: null });
  });

  // A reply of another type is not an authed answer with fields missing - it is an answer to
  // a different question. Reading `authed` off it would trust whatever that shape happens to
  // carry, so the type check comes first.
  it("falls back to signed out on a reply of the wrong type", async () => {
    reply({ type: "ok", authed: true, userId: "attacker" });
    await expect(authStatus()).resolves.toEqual({ authed: false, userId: null });
  });
});

describe("activeUserId", () => {
  it("is the id when signed in and null on every failure path", async () => {
    reply(AUTHED);
    await expect(activeUserId()).resolves.toBe("u1");

    vi.mocked(sendRuntimeMessage).mockRejectedValue(new Error("boom"));
    await expect(activeUserId()).resolves.toBeNull();
  });
});
