// SPDX-License-Identifier: GPL-3.0-or-later
//
// Decision-matrix + executor contracts for auto-press. Uses GENERIC sentinel
// elements and a mock press only - real native buttons are an e2e concern
// (site-auth suites), never simulated here.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PickerInsertionPoint, TargetRef } from "../shared/adapter";
import { resolveFbReaction } from "../shared/native-actions";
import { getAutoNative, setAutoNative } from "../shared/storage";
import { installFakeChrome } from "../test/fixtures";
import { decideNativeTrigger, type NativeTriggerInput, readPressed, runAutoPress, setFbPickPending, startFbPrewarm, stopFbPrewarm } from "./native-trigger";
import { invalidateContentSettings } from "./settings-cache";

const base: NativeTriggerInput = {
  reaction: "👍",
  sentiment: "positive",
  fbMatch: null,
  hasLike: true,
  hasDislike: false,
  hasFbMenu: false,
  likePressed: false,
  dislikePressed: null,
  recorded: null,
};

describe("decideNativeTrigger", () => {
  it("positive presses an unpressed like", () => {
    expect(decideNativeTrigger(base)).toEqual({ kind: "press-like" });
  });

  it("positive leaves an already-pressed like alone", () => {
    expect(decideNativeTrigger({ ...base, likePressed: true })).toEqual({ kind: "none" });
  });

  it("positive refuses to press when the like state is unknown", () => {
    expect(decideNativeTrigger({ ...base, likePressed: null })).toEqual({ kind: "none" });
  });

  it("positive with our recorded dislike presses like even on unknown state", () => {
    expect(decideNativeTrigger({ ...base, likePressed: null, recorded: "dislike" })).toEqual({ kind: "press-like" });
  });

  it("negative presses an unpressed dislike when the site has one", () => {
    expect(decideNativeTrigger({ ...base, sentiment: "negative", hasDislike: true, dislikePressed: false })).toEqual({ kind: "press-dislike" });
  });

  it("negative on a like-only site takes back our recorded auto-like", () => {
    expect(decideNativeTrigger({ ...base, sentiment: "negative", recorded: "like" })).toEqual({ kind: "unpress", recorded: "like" });
  });

  it("negative on a like-only site does nothing without a record", () => {
    expect(decideNativeTrigger({ ...base, sentiment: "negative" })).toEqual({ kind: "none" });
  });

  // The mirror of the two cases above. A row can expose a downvote and no upvote
  // (reddit.ts fills `like`/`dislike` independently from what it finds), and there a
  // positive pick presses nothing - but our own recorded dislike no longer matches the
  // sentiment, so it has to come back off.
  it("positive on a dislike-only row takes back our recorded auto-dislike", () => {
    expect(decideNativeTrigger({ ...base, hasLike: false, hasDislike: true, recorded: "dislike" })).toEqual({ kind: "unpress", recorded: "dislike" });
  });

  it("positive on a dislike-only row does nothing without a record", () => {
    expect(decideNativeTrigger({ ...base, hasLike: false, hasDislike: true })).toEqual({ kind: "none" });
  });

  it("neutral only cleans up our own record", () => {
    expect(decideNativeTrigger({ ...base, sentiment: "neutral" })).toEqual({ kind: "none" });
    expect(decideNativeTrigger({ ...base, sentiment: "neutral", recorded: "like" })).toEqual({ kind: "unpress", recorded: "like" });
  });

  it("un-react unpresses only what we recorded", () => {
    expect(decideNativeTrigger({ ...base, reaction: null })).toEqual({ kind: "none" });
    expect(decideNativeTrigger({ ...base, reaction: null, recorded: "dislike" })).toEqual({ kind: "unpress", recorded: "dislike" });
  });

  describe("facebook flyout", () => {
    const fb: NativeTriggerInput = { ...base, hasFbMenu: true };

    it("exact match drives the flyout, including negative reactions", () => {
      const angry = resolveFbReaction("😡");
      expect(decideNativeTrigger({ ...fb, reaction: "😡", sentiment: "negative", fbMatch: angry })).toEqual({ kind: "fb-reaction", fb: angry });
    });

    it("neutral with an exact match still drives the flyout - the FB table beats the sentiment zones", () => {
      const wow = resolveFbReaction("😮");
      expect(decideNativeTrigger({ ...fb, reaction: "😮", sentiment: "neutral", fbMatch: wow })).toEqual({ kind: "fb-reaction", fb: wow });
    });

    it("plain positive rides the flyout's Like entry", () => {
      const d = decideNativeTrigger({ ...fb, reaction: "🔥", sentiment: "positive" });
      expect(d.kind).toBe("fb-reaction");
      if (d.kind === "fb-reaction") expect(d.fb.name).toBe("like");
    });

    it("same recorded reaction is a no-op while its press is still on the button; plain-like record equals the Like entry", () => {
      const love = resolveFbReaction("❤️");
      expect(decideNativeTrigger({ ...fb, reaction: "❤️", fbMatch: love, recorded: "fb:love", likePressed: true })).toEqual({ kind: "none" });
      expect(decideNativeTrigger({ ...fb, reaction: "❤️", fbMatch: love, recorded: "fb:love", likePressed: null })).toEqual({ kind: "none" });
      expect(decideNativeTrigger({ ...fb, reaction: "🔥", sentiment: "positive", recorded: "like", likePressed: true })).toEqual({ kind: "none" });
    });

    it("a record whose press is gone re-drives the flyout instead of no-oping forever", () => {
      const love = resolveFbReaction("❤️");
      expect(decideNativeTrigger({ ...fb, reaction: "❤️", fbMatch: love, recorded: "fb:love", likePressed: false })).toEqual({ kind: "fb-reaction", fb: love });
    });

    it("switching recorded reactions re-drives the flyout", () => {
      const haha = resolveFbReaction("😂");
      expect(decideNativeTrigger({ ...fb, reaction: "😂", fbMatch: haha, recorded: "fb:love", likePressed: true })).toEqual({ kind: "fb-reaction", fb: haha });
    });

    it("a manually pressed reaction without our record is left alone", () => {
      const love = resolveFbReaction("❤️");
      expect(decideNativeTrigger({ ...fb, reaction: "❤️", fbMatch: love, likePressed: true })).toEqual({ kind: "none" });
    });

    it("negative without a match cleans up our record only", () => {
      expect(decideNativeTrigger({ ...fb, reaction: "🖕", sentiment: "negative", recorded: "fb:love", likePressed: true })).toEqual({ kind: "unpress", recorded: "fb:love" });
      expect(decideNativeTrigger({ ...fb, reaction: "🖕", sentiment: "negative" })).toEqual({ kind: "none" });
    });
  });
});

describe("readPressed", () => {
  it("prefers the adapter override when it answers", () => {
    const el = document.createElement("button");
    expect(readPressed(el, () => true)).toBe(true);
    expect(readPressed(el, () => false)).toBe(false);
  });

  // The markers below are allowed under the file's generic-sentinel rule: each is a lone
  // control carrying the literal signal readPressed itself reads (X's data-testid, GitHub's
  // star-form action), with no site markup simulated around it - cf.
  // adapters/action-labels.test.ts.
  it("falls back to aria-pressed, then data-testid, then form action", () => {
    const pressed = document.createElement("button");
    pressed.setAttribute("aria-pressed", "true");
    expect(readPressed(pressed)).toBe(true);

    const testid = document.createElement("button");
    testid.setAttribute("data-testid", "unlike");
    expect(readPressed(testid)).toBe(true);

    const form = document.createElement("form");
    form.setAttribute("action", "/o/r/unstar");
    const inForm = document.createElement("button");
    form.appendChild(inForm);
    expect(readPressed(inForm)).toBe(true);

    expect(readPressed(document.createElement("button"))).toBe(null);
  });
});

// Executor: settings gate, bookkeeping, isConnected guard, FB fallback. All
// elements are generic sentinels; press is a mock.
describe("runAutoPress", () => {
  const target: TargetRef = { site: "youtube", targetId: "v1", url: "https://www.youtube.com/watch?v=v1" };

  function makePoint(nativeVote: PickerInsertionPoint["nativeVote"]): PickerInsertionPoint {
    return { anchor: document.createElement("div"), position: "after", target, ...(nativeVote ? { nativeVote } : {}) };
  }

  function connectedButton(pressed: boolean): HTMLElement {
    const el = document.createElement("button");
    el.setAttribute("aria-pressed", String(pressed));
    document.body.appendChild(el);
    return el;
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    // The settings read is TTL-cached module state, so a value resolved against
    // the previous test's fake storage would answer this one's first read.
    invalidateContentSettings();
    installFakeChrome({ sync: { settings: { autoTriggerNative: true } } });
  });

  it("does nothing while the setting is off", async () => {
    installFakeChrome({ sync: { settings: { autoTriggerNative: false } } });
    invalidateContentSettings();
    const like = connectedButton(false);
    const press = vi.fn();
    await runAutoPress(makePoint({ like }), "👍", "u1", { press, pickFb: vi.fn() });
    expect(press).not.toHaveBeenCalled();
  });

  it("presses like, records it, and un-presses on un-react", async () => {
    const like = connectedButton(false);
    const press = vi.fn(() => like.setAttribute("aria-pressed", "true"));
    await runAutoPress(makePoint({ like }), "👍", "u1", { press, pickFb: vi.fn() });
    expect(press).toHaveBeenCalledWith(like);
    expect(await getAutoNative(target, "u1")).toBe("like");

    await runAutoPress(makePoint({ like }), null, "u1", { press, pickFb: vi.fn() });
    expect(press).toHaveBeenCalledTimes(2);
    expect(await getAutoNative(target, "u1")).toBeNull();
  });

  it("never presses a disconnected control", async () => {
    const like = document.createElement("button");
    like.setAttribute("aria-pressed", "false");
    const press = vi.fn();
    await runAutoPress(makePoint({ like }), "👍", "u1", { press, pickFb: vi.fn() });
    expect(press).not.toHaveBeenCalled();
  });

  it("un-press skips the click when the user already un-pressed manually, but clears the record", async () => {
    const like = connectedButton(false);
    await setAutoNative(target, "like", "u1");
    const press = vi.fn();
    await runAutoPress(makePoint({ like }), null, "u1", { press, pickFb: vi.fn() });
    expect(press).not.toHaveBeenCalled();
    expect(await getAutoNative(target, "u1")).toBeNull();
  });

  it("drives the FB flyout on an exact match and records the reaction", async () => {
    const like = connectedButton(false);
    const menu = { trigger: like, kind: "facebook" as const, findMenu: () => null };
    const pickFb = vi.fn().mockResolvedValue(true);
    await runAutoPress(makePoint({ like, reactionMenu: menu }), "😡", "u1", { press: vi.fn(), pickFb });
    expect(pickFb).toHaveBeenCalledWith(menu, 6);
    expect(await getAutoNative(target, "u1")).toBe("fb:angry");
  });

  it("falls back to a plain like press only for the Like entry on a provably unpressed control", async () => {
    const like = connectedButton(false);
    const menu = { trigger: like, kind: "facebook" as const, findMenu: () => null };
    const pickFb = vi.fn().mockResolvedValue(false);
    const press = vi.fn();
    await runAutoPress(makePoint({ like, reactionMenu: menu }), "🔥", "u1", { press, pickFb });
    expect(pickFb).toHaveBeenCalledWith(menu, 0);
    expect(press).toHaveBeenCalledWith(like);
    expect(await getAutoNative(target, "u1")).toBe("like");

    press.mockClear();
    await setAutoNative(target, null, "u1");
    await runAutoPress(makePoint({ like, reactionMenu: menu }), "😡", "u1", { press, pickFb });
    expect(press).not.toHaveBeenCalled();
    expect(await getAutoNative(target, "u1")).toBeNull();
  });

  it("presses dislike on a negative pick where the site has one, and records it", async () => {
    const like = connectedButton(false);
    const dislike = connectedButton(false);
    const press = vi.fn(() => dislike.setAttribute("aria-pressed", "true"));
    await runAutoPress(makePoint({ like, dislike }), "👎", "u1", { press, pickFb: vi.fn() });
    expect(press).toHaveBeenCalledWith(dislike);
    expect(await getAutoNative(target, "u1")).toBe("dislike");
  });

  it("never presses a disconnected dislike", async () => {
    const like = connectedButton(false);
    const dislike = document.createElement("button");
    dislike.setAttribute("aria-pressed", "false");
    const press = vi.fn();
    await runAutoPress(makePoint({ like, dislike }), "👎", "u1", { press, pickFb: vi.fn() });
    expect(press).not.toHaveBeenCalled();
    expect(await getAutoNative(target, "u1")).toBeNull();
  });

  it("un-react takes back a recorded dislike, and only while it still reads pressed", async () => {
    const like = connectedButton(false);
    const dislike = connectedButton(true);
    await setAutoNative(target, "dislike", "u1");
    const press = vi.fn(() => dislike.setAttribute("aria-pressed", "false"));

    await runAutoPress(makePoint({ like, dislike }), null, "u1", { press, pickFb: vi.fn() });
    expect(press).toHaveBeenCalledWith(dislike);
    expect(await getAutoNative(target, "u1")).toBeNull();

    // Second un-react with the control already unpressed: clicking it would PRESS
    // a dislike the user never asked for - the FB incident this guard exists for.
    press.mockClear();
    await setAutoNative(target, "dislike", "u1");
    await runAutoPress(makePoint({ like, dislike }), null, "u1", { press, pickFb: vi.fn() });
    expect(press).not.toHaveBeenCalled();
    expect(await getAutoNative(target, "u1")).toBeNull();
  });

  it("does nothing at all for a neutral pick with no record to clean up", async () => {
    const like = connectedButton(false);
    const press = vi.fn();
    const pickFb = vi.fn();
    // "🍕" is in neither default sentiment list, so the decision is `none`.
    await runAutoPress(makePoint({ like }), "🍕", "u1", { press, pickFb });
    expect(press).not.toHaveBeenCalled();
    expect(pickFb).not.toHaveBeenCalled();
    expect(await getAutoNative(target, "u1")).toBeNull();
  });

  it("returns before any settings read when the point offers no native action", async () => {
    const press = vi.fn();
    await runAutoPress(makePoint(undefined), "👍", "u1", { press, pickFb: vi.fn() });
    await runAutoPress(makePoint({}), "👍", "u1", { press, pickFb: vi.fn() });
    expect(press).not.toHaveBeenCalled();
  });
});

describe("stopFbPrewarm", () => {
  const fbTarget: TargetRef = { site: "facebook", targetId: "photo:1", url: "https://www.facebook.com/photo/?fbid=1" };

  function fbPoint(): { point: PickerInsertionPoint; leaveCount: () => number } {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    let leaves = 0;
    trigger.addEventListener("mouseleave", () => {
      leaves += 1;
    });
    const reactionMenu = { trigger, kind: "facebook" as const, findMenu: () => [trigger] };
    return {
      point: { anchor: document.createElement("div"), position: "after", target: fbTarget, nativeVote: { like: trigger, reactionMenu } },
      leaveCount: () => leaves,
    };
  }

  beforeEach(() => {
    document.body.innerHTML = "";
    invalidateContentSettings();
    setFbPickPending(false);
    // jsdom ships no PointerEvent, and dispatchLeave fires one first. These
    // tests assert WHEN a leave goes out, not which constructor carries it, so
    // the alias is enough. Stubbed per test (the global setup unstubs all
    // globals after each one).
    if (!("PointerEvent" in globalThis)) vi.stubGlobal("PointerEvent", MouseEvent);
  });

  // startFbPrewarm claims ownership synchronously and only reaches its hover
  // loop after an awaited settings read, so opening then closing within one
  // synchronous test exercises the stop path without any leave from the start.
  it("dismisses the flyout at once when no pick is coming", () => {
    const { point, leaveCount } = fbPoint();
    startFbPrewarm(point);
    stopFbPrewarm(point);
    expect(leaveCount()).toBe(1);
  });

  it("holds the flyout for a pick that has not reached the press yet", () => {
    vi.useFakeTimers();
    try {
      const { point, leaveCount } = fbPoint();
      startFbPrewarm(point);
      setFbPickPending(true);
      stopFbPrewarm(point);
      expect(leaveCount()).toBe(0);
      // The grace still expires, so an abandoned pick never strands the bar.
      vi.advanceTimersByTime(3000);
      expect(leaveCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A Facebook feed mounts pickers while one is open, and every mount fires
  // onOpenChange(false) once - which used to cancel the open picker's keepalive
  // and uninstall its press shield, so the user's click dismissed the flyout
  // before the auto-press could drive it.
  it("ignores a stop from a picker that did not start the prewarm", () => {
    const owner = fbPoint();
    const bystander = fbPoint();
    startFbPrewarm(owner.point);

    stopFbPrewarm(bystander.point);
    expect(bystander.leaveCount()).toBe(0);
    expect(owner.leaveCount()).toBe(0);

    stopFbPrewarm(owner.point);
    expect(owner.leaveCount()).toBe(1);
  });
});
