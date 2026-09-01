// SPDX-License-Identifier: GPL-3.0-or-later
//
// Background message-router wiring: dispatch per message type, response
// shapes, the keep-channel-open return values, the per-tab badge write, alarm
// dispatch, and the sign-out ordering (flush -> revoke -> clear). Every
// collaborator is mocked; the guard itself is covered by message-guard.test.ts
// (parseRuntimeMessage passes through here).
//
// The router itself lives in `message-router.ts`; it is driven here through the
// entrypoint that registers it (`backgroundEntry.main()`), so the registration
// and the startup wiring around it - alarms, the auth storage listener - stay
// covered by the same harness.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TargetRef } from "../shared/adapter";
import { EMPTY_HISTORY_STATS } from "../shared/messages";

vi.mock("wxt/utils/define-background", () => ({
  defineBackground: (main: () => void) => ({ main }),
}));
vi.mock("./api", () => ({
  enqueueVote: vi.fn(async () => true),
  flushOwnedVotesForSignOut: vi.fn(async () => {}),
  scheduleFlush: vi.fn(async () => {}),
  VOTE_WAKE_ALARM: "vote-wake",
}));
vi.mock("./api-read", () => ({
  apiErrorCode: vi.fn(() => "unavailable"),
  fetchCount: vi.fn(async () => ({ counts: {}, total: 0, loaded: 0, hasMore: false })),
}));
vi.mock("./debug", () => ({ logBackgroundError: vi.fn() }));
vi.mock("./history", () => ({
  exportHistory: vi.fn(async () => []),
  getHistoryPage: vi.fn(async () => ({ items: [], cursor: null })),
  getHistoryStats: vi.fn(async () => ({ total: 1, byEmoji: { "👍": 1 }, bySite: { github: 1 } })),
  importHistory: vi.fn(async () => ({ imported: 2, replaced: 1 })),
  migrateLegacyHistory: vi.fn(async () => {}),
}));
vi.mock("./identity", () => ({
  clearAuth: vi.fn(async () => {}),
  deleteAccount: vi.fn(async () => true),
  finishPendingDeletion: vi.fn(async () => {}),
  getAuth: vi.fn(async () => ({ userId: "u1", email: "e2e@example.test", token: "tok" })),
  requestOtp: vi.fn(async () => ({ ok: true, status: 200 })),
  revokeSessionServerSide: vi.fn(async () => true),
  // Deliberately WIDER than the real VerifyOtpResult, which carries no AuthState
  // (identity.ts says so at the type). The handler must forward only ok/status/error,
  // and a mock that cannot hand it a token proves nothing about that.
  verifyOtp: vi.fn(async () => ({ ok: true, status: 200, auth: { userId: "u1", token: "tok", expiresAt: 1, email: "e2e@example.test" } })),
}));
vi.mock("./install", () => ({ installFreshInstallAuthReset: vi.fn() }));
vi.mock("./message-guard", () => ({
  isExtensionPageSender: vi.fn(() => false),
  parseRuntimeMessage: vi.fn((raw: unknown) => raw),
}));
vi.mock("./popular", () => ({ ensurePopularFresh: vi.fn(async () => {}) }));
vi.mock("./reports", () => ({ reportProblem: vi.fn(async () => true) }));
vi.mock("./toolbar-icon", () => ({ applyToolbarIconForTab: vi.fn() }));
vi.mock("./vote-sync", () => ({ broadcastVoteDelta: vi.fn(async () => {}) }));
vi.mock("../shared/storage", () => ({
  applyOptimisticReaction: vi.fn(async () => {}),
  clearCountsCache: vi.fn(async () => {}),
  LEGACY_OWN_REACTIONS_KEY: "legacy-own-reactions",
  maybeSweepCountsCache: vi.fn(async () => {}),
  setCachedCounts: vi.fn(async () => {}),
  targetKey: (t: TargetRef) => `${t.site}:${t.targetId}`,
}));
vi.mock("../shared/webext", () => ({
  addAlarmListener: vi.fn(),
  createAlarm: vi.fn(),
  createTab: vi.fn(async () => ({})),
  getTab: vi.fn(async () => undefined),
  queryActiveTab: vi.fn(async () => undefined),
  setToolbarBadgeBackgroundColor: vi.fn(),
  setToolbarBadgeText: vi.fn(),
  setToolbarBadgeTextColor: vi.fn(),
  setUninstallURL: vi.fn(async () => {}),
  storageLocalRemove: vi.fn(async () => {}),
}));

import backgroundEntry from "../entrypoints/background";
import { applyOptimisticReaction, clearCountsCache, setCachedCounts } from "../shared/storage";
import { addAlarmListener, createTab, setToolbarBadgeText } from "../shared/webext";
import * as api from "./api";
import * as apiRead from "./api-read";
import { getHistoryPage } from "./history";
import * as identity from "./identity";
import { isExtensionPageSender } from "./message-guard";
import { ensurePopularFresh } from "./popular";
import { reportProblem } from "./reports";
import { broadcastVoteDelta } from "./vote-sync";

type RouteFn = (raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (r: unknown) => void) => boolean;
type Listener = (...args: unknown[]) => void;

const target: TargetRef = { site: "github", targetId: "o/r", url: "https://github.com/o/r" };
const contentSender: chrome.runtime.MessageSender = { id: "ext-id", tab: { id: 42 } as chrome.tabs.Tab, url: "https://github.com/o/r" };

let route: RouteFn;
let storageChanged: Listener;

// Drive one message through the captured router; resolves with the response.
function dispatch(msg: unknown, sender = contentSender): { keepAlive: boolean; response: Promise<unknown> } {
  let resolve!: (v: unknown) => void;
  const response = new Promise<unknown>((r) => {
    resolve = r;
  });
  const keepAlive = route(msg, sender, resolve);
  return { keepAlive, response };
}

beforeEach(async () => {
  const onMessage: RouteFn[] = [];
  const onStorage: Listener[] = [];
  vi.stubGlobal("chrome", {
    runtime: {
      id: "ext-id",
      getURL: (p: string) => `chrome-extension://ext-id/${p}`,
      onMessage: { addListener: (l: RouteFn) => onMessage.push(l) },
    },
    storage: { onChanged: { addListener: (l: Listener) => onStorage.push(l) } },
    tabs: {
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
    },
  });
  backgroundEntry.main();
  route = onMessage[0] as RouteFn;
  storageChanged = onStorage[0] as Listener;
  expect(route).toBeTypeOf("function");
  // Wait for the startup chores' terminal signal (scheduleFlush fires in
  // migrateLegacyHistory's finally, the longest chain), then count only what
  // each test does - a raced setTimeout(0) here depended on scheduler luck.
  await vi.waitFor(() => expect(api.scheduleFlush).toHaveBeenCalled());
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("message router", () => {
  it("returns false for a message the guard rejects", () => {
    expect(dispatch(null).keepAlive).toBe(false);
  });

  it("ui:injected stamps the per-tab badge and answers synchronously", async () => {
    const { keepAlive, response } = dispatch({ type: "ui:injected", targetCount: 7 });
    expect(keepAlive).toBe(false);
    await expect(response).resolves.toEqual({ type: "ok" });
    expect(setToolbarBadgeText).toHaveBeenCalledWith({ text: "7", tabId: 42 });
  });

  it("vote broadcasts the delta to other tabs and enqueues with the optional fields only when present", async () => {
    const msg = { type: "vote", target, reaction: "👍", prevReaction: null, lang: "ru" };
    const { keepAlive, response } = dispatch(msg);
    expect(keepAlive).toBe(true);
    await expect(response).resolves.toEqual({ type: "ok" });
    expect(broadcastVoteDelta).toHaveBeenCalledWith(42, { target, reaction: "👍", prevReaction: null });
    expect(api.enqueueVote).toHaveBeenCalledWith(expect.objectContaining({ target, reaction: "👍", lang: "ru" }));
    expect(vi.mocked(api.enqueueVote).mock.calls[0]?.[0]).not.toHaveProperty("title");
  });

  // A vote the queue DROPS (signed out between the tab's auth gate and this
  // message) must not answer "ok": the sending tab only rolls its optimistic
  // reaction back on an error, and no delta may reach the other tabs either.
  it("vote answers error and broadcasts nothing when the queue drops it", async () => {
    vi.mocked(api.enqueueVote).mockResolvedValueOnce(false);
    const { response } = dispatch({ type: "vote", target, reaction: "👍", prevReaction: null });
    await expect(response).resolves.toEqual({ type: "error", code: "unavailable", message: "operation failed" });
    expect(broadcastVoteDelta).not.toHaveBeenCalled();
  });

  // Re-deriving prevReaction in the SW would read an already-mutated cache and
  // corrupt the unreact history entry - the content script owns the optimistic
  // write, so the vote handler must never touch the counts cache itself.
  it("vote never re-applies the optimistic reaction or writes the counts cache", async () => {
    await dispatch({ type: "vote", target, reaction: "👍", prevReaction: null }).response;
    expect(applyOptimisticReaction).not.toHaveBeenCalled();
    expect(setCachedCounts).not.toHaveBeenCalled();
    expect(clearCountsCache).not.toHaveBeenCalled();
  });

  // The error response is what makes the sending tab roll its optimistic reaction
  // back, and that rollback is local to that tab - so a delta broadcast ahead of
  // the enqueue would strand every OTHER tab showing a reaction that was never queued.
  it("vote answers an error response when the enqueue fails, and broadcasts nothing", async () => {
    vi.mocked(api.enqueueVote).mockRejectedValueOnce(new Error("idb gone"));
    const { response } = dispatch({ type: "vote", target, reaction: "👍", prevReaction: null });
    await expect(response).resolves.toMatchObject({ type: "error", code: "unavailable" });
    expect(broadcastVoteDelta).not.toHaveBeenCalled();
  });

  it("fetchCount caches the fresh read (guarded by request time) and answers with it", async () => {
    const data = { counts: { "👍": 2 }, total: 2, loaded: 2, hasMore: false, myReaction: "👍" };
    vi.mocked(apiRead.fetchCount).mockResolvedValueOnce(data as never);
    const { keepAlive, response } = dispatch({ type: "fetchCount", target, limit: 3 });
    expect(keepAlive).toBe(true);
    await expect(response).resolves.toEqual({ type: "count", data });
    expect(setCachedCounts).toHaveBeenCalledWith({ "github:o/r": { value: data, myReaction: "👍" } }, { skipIfCachedAfter: expect.any(Number) });
  });

  it("fetchCount maps a failed read through apiErrorCode", async () => {
    vi.mocked(apiRead.fetchCount).mockRejectedValueOnce(new Error("offline"));
    const { response } = dispatch({ type: "fetchCount", target });
    await expect(response).resolves.toMatchObject({ type: "error", code: "unavailable" });
  });

  it("report answers ok only when the report actually reached the server", async () => {
    const msg = { type: "report", site: "github", host: "github.com", url: "https://github.com/o/r", targetCount: 1 };
    await expect(dispatch(msg).response).resolves.toEqual({ type: "ok" });
    vi.mocked(reportProblem).mockResolvedValueOnce(false);
    await expect(dispatch(msg).response).resolves.toMatchObject({ type: "error", code: "unavailable" });
  });

  it("history:stats routes through the authed responder", async () => {
    await expect(dispatch({ type: "history:stats" }).response).resolves.toEqual({ type: "history:stats", stats: { total: 1, byEmoji: { "👍": 1 }, bySite: { github: 1 } }, authed: true });
    vi.mocked(identity.getAuth).mockResolvedValueOnce(null);
    await expect(dispatch({ type: "history:stats" }).response).resolves.toEqual({ type: "history:stats", stats: EMPTY_HISTORY_STATS, authed: false });
  });

  it("history:import forwards the rows and echoes the tally", async () => {
    await expect(dispatch({ type: "history:import", rows: [{ a: 1 }] }).response).resolves.toEqual({ type: "history:import", imported: 2, replaced: 1, authed: true });
  });

  it("auth:status withholds the email from content scripts and reveals it to extension pages", async () => {
    await expect(dispatch({ type: "auth:status" }).response).resolves.toEqual({ type: "auth:status", authed: true, userId: "u1", email: null });
    vi.mocked(isExtensionPageSender).mockReturnValueOnce(true);
    await expect(dispatch({ type: "auth:status" }).response).resolves.toMatchObject({ email: "e2e@example.test" });
  });

  // The JWT (and the account email) must never reach a web page or content script.
  // The mocked session above hands the router a real `token`, so a regression that
  // spreads the auth state into the reply shows up here and nowhere else.
  it("the auth:status handler gates email and never returns the JWT", async () => {
    const toContentScript = await dispatch({ type: "auth:status" }).response;
    expect(toContentScript).not.toHaveProperty("token");
    expect(toContentScript).toMatchObject({ email: null });
    vi.mocked(isExtensionPageSender).mockReturnValueOnce(true);
    const toExtensionPage = await dispatch({ type: "auth:status" }).response;
    expect(toExtensionPage).not.toHaveProperty("token");
    expect(toExtensionPage).toMatchObject({ email: "e2e@example.test" });
  });

  it("auth:openTab opens the auth page", async () => {
    await expect(dispatch({ type: "auth:openTab" }).response).resolves.toEqual({ type: "ok" });
    expect(createTab).toHaveBeenCalledWith({ url: "chrome-extension://ext-id/auth.html" });
  });

  it("auth:signOut flushes owned votes BEFORE revoking, and clears auth last", async () => {
    const order: string[] = [];
    vi.mocked(api.flushOwnedVotesForSignOut).mockImplementationOnce(async () => {
      order.push("flush");
    });
    vi.mocked(identity.revokeSessionServerSide).mockImplementationOnce(async () => {
      order.push("revoke");
      return true;
    });
    vi.mocked(identity.clearAuth).mockImplementationOnce(async () => {
      order.push("clear");
    });
    await expect(dispatch({ type: "auth:signOut" }).response).resolves.toEqual({ type: "ok" });
    expect(order).toEqual(["flush", "revoke", "clear"]);
  });

  it("auth:signOut still clears local auth when the server revoke fails", async () => {
    vi.mocked(identity.revokeSessionServerSide).mockResolvedValueOnce(false);
    await expect(dispatch({ type: "auth:signOut" }).response).resolves.toEqual({ type: "ok" });
    expect(identity.clearAuth).toHaveBeenCalledTimes(1);
  });

  it("auth:delete maps the outcome to ok / error", async () => {
    await expect(dispatch({ type: "auth:delete" }).response).resolves.toEqual({ type: "ok" });
    vi.mocked(identity.deleteAccount).mockResolvedValueOnce(false);
    await expect(dispatch({ type: "auth:delete" }).response).resolves.toMatchObject({ type: "error" });
  });

  it("auth:requestOtp forwards the address and passes the API's status/detail straight back", async () => {
    await expect(dispatch({ type: "auth:requestOtp", email: "a@b.com" }).response).resolves.toEqual({ type: "auth:otpRequested", ok: true, status: 200 });
    expect(identity.requestOtp).toHaveBeenCalledWith("a@b.com");

    vi.mocked(identity.requestOtp).mockResolvedValueOnce({ ok: false, status: 429, error: "rate_limited", retryAfterSeconds: 42 });
    await expect(dispatch({ type: "auth:requestOtp", email: "a@b.com" }).response).resolves.toEqual({
      type: "auth:otpRequested",
      ok: false,
      status: 429,
      error: "rate_limited",
      retryAfterSeconds: 42,
    });
  });

  // The verify response is the one place a freshly minted bearer token could leak
  // onto the runtime channel. It is already stored by the worker; the page only
  // needs to know it worked.
  it("auth:verifyOtp answers the outcome only, never the minted session", async () => {
    const response = await dispatch({ type: "auth:verifyOtp", email: "a@b.com", code: "123456" }).response;

    expect(response).toEqual({ type: "auth:otpVerified", ok: true, status: 200 });
    expect(identity.verifyOtp).toHaveBeenCalledWith("a@b.com", "123456");
    expect(JSON.stringify(response)).not.toContain("tok");

    vi.mocked(identity.verifyOtp).mockResolvedValueOnce({ ok: false, status: 401, error: "bad_code" });
    await expect(dispatch({ type: "auth:verifyOtp", email: "a@b.com", code: "000000" }).response).resolves.toEqual({ type: "auth:otpVerified", ok: false, status: 401, error: "bad_code" });
  });

  it("history:page and history:export answer through the authed responder", async () => {
    await expect(dispatch({ type: "history:page", limit: 5 }).response).resolves.toEqual({ type: "history:page", items: [], cursor: null, authed: true });
    await expect(dispatch({ type: "history:export" }).response).resolves.toEqual({ type: "history:export", rows: [], authed: true });
    vi.mocked(identity.getAuth).mockResolvedValueOnce(null);
    await expect(dispatch({ type: "history:export" }).response).resolves.toEqual({ type: "history:export", rows: [], authed: false });
  });

  // Every case answers on BOTH arms of its promise. A rejection that fell
  // through would leave `sendResponse` uncalled with the channel held open, and
  // the caller's promise would hang until the runtime timeout rather than show
  // the user an error.
  it("answers an error response instead of hanging when a handler rejects", async () => {
    vi.mocked(reportProblem).mockRejectedValueOnce(new Error("network"));
    const reportMsg = { type: "report", site: "github", host: "github.com", url: "https://github.com/o/r", targetCount: 1 };
    await expect(dispatch(reportMsg).response).resolves.toMatchObject({ type: "error", code: "unavailable" });

    vi.mocked(identity.getAuth).mockRejectedValueOnce(new Error("storage gone"));
    await expect(dispatch({ type: "auth:status" }).response).resolves.toMatchObject({ type: "error", code: "unavailable" });

    vi.mocked(identity.deleteAccount).mockRejectedValueOnce(new Error("offline"));
    await expect(dispatch({ type: "auth:delete" }).response).resolves.toMatchObject({ type: "error", code: "unavailable" });

    vi.mocked(getHistoryPage).mockRejectedValueOnce(new Error("idb gone"));
    await expect(dispatch({ type: "history:page" }).response).resolves.toMatchObject({ type: "error", code: "unavailable" });

    vi.mocked(identity.requestOtp).mockRejectedValueOnce(new Error("offline"));
    await expect(dispatch({ type: "auth:requestOtp", email: "a@b.com" }).response).resolves.toMatchObject({ type: "error", code: "unavailable" });

    vi.mocked(identity.verifyOtp).mockRejectedValueOnce(new Error("offline"));
    await expect(dispatch({ type: "auth:verifyOtp", email: "a@b.com", code: "123456" }).response).resolves.toMatchObject({ type: "error", code: "unavailable" });
  });
});

describe("background wiring beyond the router", () => {
  it("dispatches the vote-wake and popular-refresh alarms", () => {
    const listener = vi.mocked(addAlarmListener).mock.calls[0]?.[0] as ((a: { name: string }) => void) | undefined;
    // The listener was registered during main() (before the clearAllMocks in
    // beforeEach), so re-run main to capture it fresh.
    expect(listener).toBeUndefined();
    backgroundEntry.main();
    const fresh = vi.mocked(addAlarmListener).mock.calls[0]?.[0] as (a: { name: string }) => void;
    vi.clearAllMocks();
    fresh({ name: api.VOTE_WAKE_ALARM });
    expect(api.scheduleFlush).toHaveBeenCalledTimes(1);
    fresh({ name: "popular-refresh" });
    expect(ensurePopularFresh).toHaveBeenCalledTimes(1);
    fresh({ name: "unrelated" });
    expect(api.scheduleFlush).toHaveBeenCalledTimes(1);
  });

  it("clears the counts cache when the local auth key changes, and only then", () => {
    storageChanged({ auth_v1: {} }, "local");
    expect(clearCountsCache).toHaveBeenCalledTimes(1);
    storageChanged({ other: {} }, "local");
    storageChanged({ auth_v1: {} }, "sync");
    expect(clearCountsCache).toHaveBeenCalledTimes(1);
  });
});
