// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VoteSyncMessage } from "../shared/messages";
import { targetKey } from "../shared/storage";
import { resetMountRegistryForTests, setVoteListener } from "./mount-registry";
import { handleVoteSyncMessage } from "./vote-sync";

const RUNTIME_ID = "our-extension-id";
const target = {
  site: "reddit" as const,
  targetId: "t3_abc",
  url: "https://www.reddit.com/r/x/comments/abc/",
};
const KEY = targetKey(target);

function voteSync(reaction: string | null, prevReaction: string | null = null): VoteSyncMessage {
  return { type: "voteSync", target, reaction, prevReaction };
}

function sender(id?: string): chrome.runtime.MessageSender {
  return { id } as chrome.runtime.MessageSender;
}

afterEach(() => {
  resetMountRegistryForTests();
});

describe("handleVoteSyncMessage - cross-tab vote sync trust gate", () => {
  it("dispatches a voteSync from our own extension to the target's picker", () => {
    const cb = vi.fn();
    setVoteListener(KEY, cb);

    const handled = handleVoteSyncMessage(voteSync("👍"), sender(RUNTIME_ID), RUNTIME_ID);

    expect(handled).toBe(true);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ target, reaction: "👍", prevReaction: null });
  });

  it("ignores a voteSync whose sender is NOT our extension (spoof attempt)", () => {
    const cb = vi.fn();
    setVoteListener(KEY, cb);

    expect(handleVoteSyncMessage(voteSync("😡"), sender("evil-extension"), RUNTIME_ID)).toBe(false);
    expect(handleVoteSyncMessage(voteSync("😡"), sender(undefined), RUNTIME_ID)).toBe(false);

    expect(cb).not.toHaveBeenCalled();
  });

  it("ignores non-voteSync and malformed messages without throwing", () => {
    const cb = vi.fn();
    setVoteListener(KEY, cb);

    expect(handleVoteSyncMessage({ type: "vote" }, sender(RUNTIME_ID), RUNTIME_ID)).toBe(false);
    expect(handleVoteSyncMessage(null, sender(RUNTIME_ID), RUNTIME_ID)).toBe(false);
    expect(handleVoteSyncMessage("x", sender(RUNTIME_ID), RUNTIME_ID)).toBe(false);
    expect(handleVoteSyncMessage({ type: "voteSync", target: { site: 1 } }, sender(RUNTIME_ID), RUNTIME_ID)).toBe(false);

    expect(cb).not.toHaveBeenCalled();
  });

  it("accepts the unreact shape (null reaction) for a known target", () => {
    const cb = vi.fn();
    setVoteListener(KEY, cb);

    expect(handleVoteSyncMessage(voteSync(null, "👍"), sender(RUNTIME_ID), RUNTIME_ID)).toBe(true);
    expect(cb).toHaveBeenCalledWith({ target, reaction: null, prevReaction: "👍" });
  });

  it("is a no-op (still trusted) when no picker is mounted for the target", () => {
    // No listener for this key - nothing to update, and crucially nothing throws.
    expect(handleVoteSyncMessage(voteSync("👍"), sender(RUNTIME_ID), RUNTIME_ID)).toBe(true);
  });
});
