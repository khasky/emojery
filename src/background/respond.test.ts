// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./identity", () => ({ getAuth: vi.fn() }));
vi.mock("./debug", () => ({ logBackgroundError: vi.fn() }));

import type { RuntimeResponse } from "../shared/messages";
import { getAuth } from "./identity";
import { errorResponse, respondAuthed } from "./respond";

const EMPTY: RuntimeResponse = { type: "history:stats", stats: { total: 0, byEmoji: {}, bySite: {} }, authed: false };

function captureResponse(): { sendResponse: (r: RuntimeResponse) => void; settled: Promise<RuntimeResponse> } {
  let resolve!: (r: RuntimeResponse) => void;
  const settled = new Promise<RuntimeResponse>((r) => {
    resolve = r;
  });
  return { sendResponse: resolve, settled };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("respondAuthed", () => {
  it("answers the empty payload when the session is signed out", async () => {
    vi.mocked(getAuth).mockResolvedValue(null);
    const { sendResponse, settled } = captureResponse();

    respondAuthed(sendResponse, EMPTY, async () => ({ type: "ok" }), "history:stats");

    await expect(settled).resolves.toEqual(EMPTY);
  });

  it("answers an error - not the empty payload - when the work fails", async () => {
    // The empty payload carries `authed: false`, which the popup renders as a
    // sign-in prompt. A signed-in user whose history could not be read must not
    // be told to sign in again.
    vi.mocked(getAuth).mockResolvedValue({ userId: "u1", token: "t", expiresAt: 9999999999 } as Awaited<ReturnType<typeof getAuth>>);
    const { sendResponse, settled } = captureResponse();

    respondAuthed(
      sendResponse,
      EMPTY,
      async () => {
        throw new Error("IndexedDB unavailable");
      },
      "history:stats",
    );

    await expect(settled).resolves.toEqual({ type: "error", code: "unavailable", message: "operation failed" });
  });
});

describe("errorResponse", () => {
  it("keeps the cause out of the payload", () => {
    const response = errorResponse("server", "fetchCount", new Error("token=abc123 rejected by https://internal.host/x"));

    expect(response).toEqual({ type: "error", code: "server", message: "server error" });
  });
});
