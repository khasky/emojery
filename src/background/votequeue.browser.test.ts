// SPDX-License-Identifier: GPL-3.0-or-later
//
// The vote queue against REAL IndexedDB (Vitest browser mode): one record per pair, a click
// replacing the desire and raising the counter, the confirmed state a settled record leaves
// behind, a settle that loses to a newer click, and the account-scoped wipe.
import { afterEach, describe, expect, it } from "vitest";
import type { TargetRef } from "../shared/adapter";
import { clearQueuedVotes, getQueueStats, listQueuedVotes, pairKey, peekNextEligible, rememberPairs, settleVote, updateVote, upsertClick } from "./votequeue";

const target: TargetRef = { site: "github", targetId: "khasky/emojery", url: "https://github.com/khasky/emojery" };
const other: TargetRef = { ...target, targetId: "khasky/other", url: "https://github.com/khasky/other" };

function click(userId: string, t: TargetRef, desired: string | null, prevReaction: string | null, now = 1000) {
  return upsertClick({ pair: pairKey(userId, t), userId, target: t, desired, prevReaction, now });
}

afterEach(async () => {
  await clearQueuedVotes();
});

describe("the vote queue", () => {
  it("keeps one record per pair, the latest desire, a counter past every earlier one, the first rollback target", async () => {
    const first = await click("u1", target, "👍", null);
    expect(first).toMatchObject({ desired: "👍", base: null, counter: 1, rollbackTo: null });
    const second = await click("u1", target, "❤️", "👍", 2000);
    expect(second).toMatchObject({ id: first.id, desired: "❤️", base: null, counter: 2, rollbackTo: null, firstQueuedAt: 1000 });
    await click("u1", other, "🔥", null);
    expect((await getQueueStats()).count).toBe(2);
  });

  it("builds the next click on the state a settled record confirmed, or on what /v2/mine reported", async () => {
    const sent = await click("u1", target, "👍", null);
    await settleVote(sent, { pair: sent.pair, reaction: "👍", counter: 1 });
    expect((await getQueueStats()).count).toBe(0);
    expect(await click("u1", target, "❤️", "👍")).toMatchObject({ base: "👍", counter: 2 });

    await rememberPairs([{ pair: pairKey("u1", other), reaction: "🔥", counter: 9 }]);
    expect(await click("u1", other, null, "🔥")).toMatchObject({ base: "🔥", counter: 10 });
  });

  it("keeps a record a newer click replaced while its send was in flight", async () => {
    const sent = await click("u1", target, "👍", null);
    const newer = await click("u1", target, "❤️", "👍");
    await settleVote(sent, { pair: sent.pair, reaction: "👍", counter: 1 });
    const left = await listQueuedVotes(10);
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ desired: "❤️", counter: newer.counter, base: "👍" });
    // An update from the older send cannot overwrite the newer click either.
    await updateVote({ ...sent, attempts: 5 });
    expect((await listQueuedVotes(10))[0]?.attempts).toBe(0);
  });

  it("serves records whose backoff passed, skipping those it was told to", async () => {
    const a = await click("u1", target, "👍", null);
    const b = await click("u1", other, "🔥", null);
    await updateVote({ ...a, nextAttemptAt: 5_000 });
    expect((await peekNextEligible(1_000))?.id).toBe(b.id);
    expect(await peekNextEligible(1_000, new Set([b.id]))).toBeUndefined();
    expect((await peekNextEligible(6_000))?.id).toBe(a.id);
  });

  it("wipes one account's records and known pairs, leaving another's", async () => {
    await click("u1", target, "👍", null);
    await click("u2", target, "❤️", null);
    await rememberPairs([{ pair: pairKey("u1", other), reaction: "🔥", counter: 3 }]);
    await clearQueuedVotes("u1");
    const left = await listQueuedVotes(10);
    expect(left.map((v) => v.userId)).toEqual(["u2"]);
    expect(await click("u1", other, "😂", "🔥")).toMatchObject({ base: "🔥", counter: 1 });
  });
});
