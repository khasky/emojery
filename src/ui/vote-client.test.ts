// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./messaging", () => ({ sendMessage: vi.fn() }));
vi.mock("../shared/storage", async (importOriginal) => {
  // Spread keeps getAutoNative/setAutoNative real for the transitively imported native-trigger.ts.
  const actual = await importOriginal<typeof import("../shared/storage")>();
  return { ...actual, applyOptimisticReaction: vi.fn(), getSettings: vi.fn().mockResolvedValue({ reactionAnimations: false }) };
});
vi.mock("./animations", () => ({ playReactionClickFloat: vi.fn() }));
vi.mock("./mount-registry", () => ({ dispatchVoteSync: vi.fn() }));

import type { PickerInsertionPoint } from "../shared/adapter";
import type { RuntimeMessage, RuntimeResponse } from "../shared/messages";
import type { Settings } from "../shared/storage";
import { applyOptimisticReaction, getSettings } from "../shared/storage";
import { playReactionClickFloat } from "./animations";
import { sendMessage } from "./messaging";
import { dispatchVoteSync } from "./mount-registry";
import { invalidateContentSettings } from "./settings-cache";
import { createOnPick } from "./vote-client";

const point: PickerInsertionPoint = {
  anchor: document.createElement("div"),
  position: "after",
  target: { site: "facebook", targetId: "1", url: "u" },
};

const settings = {
  enabled: true,
  replaceNative: false,
  reactionAnimations: false,
  sites: {},
} as unknown as Settings;

// The sendMessage stub every case repeats: auth:status answers as an authed "u1"
// (fields overridable per case); every other message goes through `reply` - ok
// unless the case makes the vote itself fail.
function mockAuthedSend(status: Partial<{ authed: boolean; userId: string | null }> = {}, reply: (msg: RuntimeMessage) => Promise<RuntimeResponse> = () => Promise.resolve({ type: "ok" })): void {
  vi.mocked(sendMessage).mockImplementation((msg) => (msg.type === "auth:status" ? Promise.resolve({ type: "auth:status", authed: true, userId: "u1", email: null, ...status }) : reply(msg)));
}

beforeEach(() => {
  // clearAllMocks keeps the factory mock implementations (getSettings' resolved value);
  // restoreAllMocks would strip them and break later tests, so it is intentionally not used.
  vi.clearAllMocks();
  document.documentElement.lang = "uk-UA";
  // The content-script settings read is TTL-cached module state, so a value
  // resolved against the previous test's getSettings mock would answer here.
  invalidateContentSettings();
});

afterEach(() => {
  // Restore the factory default HERE, not on each test's last line: an
  // assertion failure would skip an in-test restore and poison later tests.
  vi.mocked(getSettings).mockResolvedValue({ reactionAnimations: false } as never);
});

describe("createOnPick", () => {
  it("unauthed click opens the auth tab and drops the vote", async () => {
    mockAuthedSend({ authed: false, userId: null });
    const onPick = createOnPick({ point, settings });
    const result = await onPick("❤️");
    expect(result).toBe(false);
    expect(sendMessage).toHaveBeenCalledWith({ type: "auth:openTab" });
    expect(applyOptimisticReaction).not.toHaveBeenCalled();
  });

  it("authed click applies optimistic state and sends the vote with prevReaction", async () => {
    mockAuthedSend();
    vi.mocked(applyOptimisticReaction).mockResolvedValue({
      next: {} as never,
      prevReaction: "👍",
    });

    const onPick = createOnPick({ point, settings });
    const result = await onPick("❤️");

    expect(result).toBe(true);
    expect(applyOptimisticReaction).toHaveBeenCalledWith(point.target, "❤️", "u1");
    expect(sendMessage).toHaveBeenCalledWith({
      type: "vote",
      target: point.target,
      reaction: "❤️",
      prevReaction: "👍",
      lang: "uk-UA",
    });
  });

  it("treats an authed status without a userId as unauthed (no unowned writes)", async () => {
    mockAuthedSend({ userId: null });
    const onPick = createOnPick({ point, settings });
    const result = await onPick("❤️");
    expect(result).toBe(false);
    expect(applyOptimisticReaction).not.toHaveBeenCalled();
  });

  it("forwards an unreact (reaction null) with the previous emoji", async () => {
    mockAuthedSend();
    vi.mocked(applyOptimisticReaction).mockResolvedValue({
      next: {} as never,
      prevReaction: "👍",
    });

    const onPick = createOnPick({ point, settings });
    await onPick(null);

    expect(sendMessage).toHaveBeenCalledWith({
      type: "vote",
      target: point.target,
      reaction: null,
      prevReaction: "👍",
      lang: "uk-UA",
    });
  });

  it("rolls the optimistic reaction back when the background refuses the vote", async () => {
    // A refused vote used to leave the emoji on screen forever: storage kept it
    // and the picker was never told. Both are walked back to prevReaction.
    mockAuthedSend({}, (msg) => (msg.type === "vote" ? Promise.resolve({ type: "error", code: "unavailable", message: "operation failed" }) : Promise.resolve({ type: "ok" })));
    vi.mocked(applyOptimisticReaction).mockResolvedValue({ next: {} as never, prevReaction: "👍" });

    const onPick = createOnPick({ point, settings });
    await onPick("❤️");
    await vi.waitFor(() => expect(dispatchVoteSync).toHaveBeenCalled());

    expect(applyOptimisticReaction).toHaveBeenLastCalledWith(point.target, "👍", "u1");
    expect(dispatchVoteSync).toHaveBeenCalledWith({ target: point.target, reaction: "👍", prevReaction: "❤️" });
  });

  it("leaves the optimistic reaction alone when the background accepts the vote", async () => {
    mockAuthedSend();
    vi.mocked(applyOptimisticReaction).mockResolvedValue({ next: {} as never, prevReaction: null });

    const onPick = createOnPick({ point, settings });
    await onPick("❤️");
    await Promise.resolve();
    await Promise.resolve();

    expect(applyOptimisticReaction).toHaveBeenCalledTimes(1);
    expect(dispatchVoteSync).not.toHaveBeenCalled();
  });

  it("rolls back when the vote message itself fails to send (SW gone)", async () => {
    mockAuthedSend({}, (msg) => (msg.type === "vote" ? Promise.reject(new Error("Extension context invalidated")) : Promise.resolve({ type: "ok" })));
    vi.mocked(applyOptimisticReaction).mockResolvedValue({ next: {} as never, prevReaction: null });

    const onPick = createOnPick({ point, settings });
    await onPick("❤️");
    await vi.waitFor(() => expect(dispatchVoteSync).toHaveBeenCalled());

    expect(applyOptimisticReaction).toHaveBeenLastCalledWith(point.target, null, "u1");
    expect(dispatchVoteSync).toHaveBeenCalledWith({ target: point.target, reaction: null, prevReaction: "❤️" });
  });

  it("falls back to the browser language when the page declares none, and forwards the page title", async () => {
    document.documentElement.lang = "";
    document.title = "  A page title  ";
    mockAuthedSend();
    vi.mocked(applyOptimisticReaction).mockResolvedValue({ next: {} as never, prevReaction: null });

    const onPick = createOnPick({ point, settings });
    await onPick("❤️");

    expect(sendMessage).toHaveBeenCalledWith({
      type: "vote",
      target: point.target,
      reaction: "❤️",
      prevReaction: null,
      lang: navigator.language,
      title: "A page title",
    });
    document.title = "";
  });

  it("plays the click animation when the setting is on", async () => {
    vi.mocked(getSettings).mockResolvedValue({ reactionAnimations: true } as never);
    mockAuthedSend();
    vi.mocked(applyOptimisticReaction).mockResolvedValue({ next: {} as never, prevReaction: null });

    const onPick = createOnPick({ point, settings });
    await onPick("❤️");
    await vi.waitFor(() => expect(playReactionClickFloat).toHaveBeenCalledWith("❤️", undefined));
  });

  it("never plays the click animation for an unreact", async () => {
    vi.mocked(getSettings).mockResolvedValue({ reactionAnimations: true } as never);
    mockAuthedSend();
    vi.mocked(applyOptimisticReaction).mockResolvedValue({ next: {} as never, prevReaction: "👍" });

    const onPick = createOnPick({ point, settings });
    await onPick(null);
    // A subsequent real pick proves the async settings->animation chain has
    // flushed - the unreact before it must not have queued a play.
    await onPick("❤️");
    await vi.waitFor(() => expect(playReactionClickFloat).toHaveBeenCalledWith("❤️", undefined));
    expect(playReactionClickFloat).toHaveBeenCalledTimes(1);
  });
});
