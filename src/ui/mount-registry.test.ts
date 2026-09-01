// SPDX-License-Identifier: GPL-3.0-or-later
//
// The mount bookkeeping as one unit, across the three modules that split it: live mounts
// (mount-registry), deferred ones (mount-anchors) and what outlives both (mount-session).
// Kept in one file because the cases that matter are the hand-offs between them - a
// teardown that must reach every collection, a route change that must drop pending and
// live mounts alike.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PickerInsertionPoint } from "../shared/adapter";
import { HOST_CLASS, MOUNT_ATTR } from "../shared/dom";
import type { TargetKey } from "../shared/storage";
import { tk } from "../test/target-key";
import { observePendingAnchor, pendingMountPoint, setPendingMount } from "./mount-anchors";
import {
  claimMountAnchor,
  clearAdjacentMountNodes,
  clearStaleAnchorMount,
  dispatchVoteSync,
  dropMount,
  hostElementOfMount,
  isCurrentMountPoint,
  mountedNode,
  moveMountNode,
  pruneDisconnected,
  reconcileScanMounts,
  registerMountNode,
  removeMountNode,
  resetMountRegistryForTests,
  setVoteListener,
  teardownAllMounts,
  WRAPPER_SPEC_ATTR,
  wrapperSpecChanged,
  wrapperSpecKey,
} from "./mount-registry";
import { clearPlacedTargets, detectRouteChange, markFirstPlacement, recordShownTarget, shownTargetCount } from "./mount-session";

describe("placement animation gating", () => {
  it("plays the drop-in only the first time a target's trigger is placed", () => {
    clearPlacedTargets();
    expect(markFirstPlacement(tk("instagram:abc"))).toBe(true);
    // A virtualized feed re-creates the host on scroll-back; replaying the drop-in would read
    // as re-injection (see the gate note on placedTargetKeys in mount-session.ts).
    expect(markFirstPlacement(tk("instagram:abc"))).toBe(false);
    expect(markFirstPlacement(tk("instagram:abc"))).toBe(false);
    expect(markFirstPlacement(tk("instagram:def"))).toBe(true);
  });

  it("never replays after an SPA route change - the set is bounded, not route-scoped", () => {
    clearPlacedTargets();
    expect(markFirstPlacement(tk("x:route-a"))).toBe(true);
    history.replaceState(null, "", "/somewhere-else");
    try {
      expect(detectRouteChange()).toBe(true);
      expect(markFirstPlacement(tk("x:route-a"))).toBe(false);
    } finally {
      history.replaceState(null, "", "/");
    }
  });

  it("evicts the oldest keys past the cap instead of growing without bound", () => {
    clearPlacedTargets();
    expect(markFirstPlacement(tk("x:first"))).toBe(true);
    for (let i = 0; i < 2_000; i++) markFirstPlacement(tk(`x:${i}`));
    expect(markFirstPlacement(tk("x:1999"))).toBe(false);
    expect(markFirstPlacement(tk("x:first"))).toBe(true);
  });

  it("re-enables the drop-in after a full teardown (master toggle off->on)", () => {
    clearPlacedTargets();
    expect(markFirstPlacement(tk("x:1"))).toBe(true);
    expect(markFirstPlacement(tk("x:1"))).toBe(false);
    teardownAllMounts(); // extension switched off from the popup
    expect(markFirstPlacement(tk("x:1"))).toBe(true);
  });
});

describe("shownTargetCount - monotonic visible-picker tally (badge never ticks down)", () => {
  afterEach(() => {
    teardownAllMounts();
  });

  it("counts each distinct target once and never decrements on re-mount", () => {
    teardownAllMounts();
    recordShownTarget(tk("threads:1"));
    recordShownTarget(tk("threads:2"));
    expect(shownTargetCount()).toBe(2);
    recordShownTarget(tk("threads:1"));
    expect(shownTargetCount()).toBe(2);
    recordShownTarget(tk("threads:3"));
    expect(shownTargetCount()).toBe(3);
  });

  it("resets to zero on teardown (master toggle off / navigation)", () => {
    recordShownTarget(tk("x:1"));
    expect(shownTargetCount()).toBeGreaterThan(0);
    teardownAllMounts();
    expect(shownTargetCount()).toBe(0);
  });

  // An endless feed never changes route, so nothing else would ever clear this.
  // The tally freezes at the cap instead of holding a key per post forever.
  it("stops growing at the cap rather than retaining a key per post forever", () => {
    teardownAllMounts();
    for (let i = 0; i < 10_050; i++) recordShownTarget(tk(`reddit:${i}`));
    expect(shownTargetCount()).toBe(10_000);
  });
});

describe("claimMountAnchor - one connected anchor per target key", () => {
  afterEach(() => {
    teardownAllMounts();
  });

  // Framework contract on generic elements (no supported-site DOM): when the
  // same target key is re-claimed on a new anchor, the previous anchor must
  // release MOUNT_ATTR so a key never sits on two connected anchors at once. The
  // actual re-anchor flow on live pages is covered by the e2e duplicate-key
  // invariant; this only pins the registry helper's bookkeeping.
  it("releases the previous anchor when the same key is re-claimed", () => {
    const KEY = tk("k1");
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.append(a, b);

    claimMountAnchor(a, KEY);
    expect(a.getAttribute(MOUNT_ATTR)).toBe(KEY);

    claimMountAnchor(b, KEY);
    expect(b.getAttribute(MOUNT_ATTR)).toBe(KEY);
    expect(a.hasAttribute(MOUNT_ATTR)).toBe(false);

    const carriers = document.querySelectorAll(`[${MOUNT_ATTR}="${KEY}"]`);
    expect(carriers).toHaveLength(1);
  });

  it("does not disturb a different target's anchor", () => {
    const a = document.createElement("div");
    const b = document.createElement("div");
    document.body.append(a, b);
    claimMountAnchor(a, tk("k1"));
    claimMountAnchor(b, tk("k2"));
    expect(a.getAttribute(MOUNT_ATTR)).toBe("k1");
    expect(b.getAttribute(MOUNT_ATTR)).toBe("k2");
  });
});

// On a route change the fresh scan is the authority - the Threads /media story lives on
// reconcileScanMounts in mount-registry.ts. An in-place re-key (FB pfbid -> numeric rewrite)
// is covered either way: the new key's point rebuilds at the same anchor on this very scan.
describe("reconcileScanMounts - route change drops stale mounts", () => {
  afterEach(() => {
    teardownAllMounts();
  });

  function fakeMount(key: TargetKey): { anchor: HTMLElement; node: HTMLElement } {
    const anchor = document.createElement("div");
    const node = document.createElement("span");
    node.className = HOST_CLASS;
    document.body.append(anchor, node);
    registerMountNode(key, node);
    claimMountAnchor(anchor, key);
    return { anchor, node };
  }

  it("removes a connected stale host once the route's scan stops producing its key", () => {
    const { node } = fakeMount(tk("facebook:pfbidA"));
    reconcileScanMounts([], { removeConnectedStale: true });
    expect(node.isConnected).toBe(false);
    expect(mountedNode(tk("facebook:pfbidA")) !== undefined).toBe(false);
  });

  it("keeps a connected stale host while the route is unchanged (no removeConnectedStale)", () => {
    const { node } = fakeMount(tk("facebook:pfbidC"));
    reconcileScanMounts([], { removeConnectedStale: false });
    expect(node.isConnected).toBe(true);
    expect(mountedNode(tk("facebook:pfbidC")) !== undefined).toBe(true);
  });

  it("removes a stale host once its anchor detaches (real navigation / recycle)", () => {
    const { anchor, node } = fakeMount(tk("facebook:pfbidB"));
    anchor.remove(); // the post's DOM was replaced - the anchor is gone
    reconcileScanMounts([], { removeConnectedStale: true });
    expect(node.isConnected).toBe(false);
    expect(mountedNode(tk("facebook:pfbidB")) !== undefined).toBe(false);
  });
});

// An SPA route change can move the SAME target onto a surface whose binding
// declares a different wrapper (X status row <-> its narrow photo-view row).
// Reusing the node then carried the old wrapper's flex/margins into the new
// row - the trigger squashed against the like count until a page refresh.
describe("wrapperSpecChanged - rebuild the mount when the surface's wrapper differs", () => {
  const TARGET = { site: "x", targetId: "1", url: "https://x.com/u/status/1" } as const;
  const ROW_WRAPPER = { tagName: "div", style: "display: flex; flex: 1 1 0%; margin-inline-end: 32px;" };
  const PHOTO_WRAPPER = { tagName: "div", style: "display: flex; flex: 1 1 0%;" };

  function point(wrapper?: PickerInsertionPoint["wrapper"]): PickerInsertionPoint {
    const anchor = document.createElement("div");
    return { anchor, position: "after", target: TARGET, ...(wrapper ? { wrapper } : {}) };
  }

  function wrappedMount(wrapper: NonNullable<PickerInsertionPoint["wrapper"]>): HTMLElement {
    const el = document.createElement(wrapper.tagName);
    el.style.cssText = wrapper.style ?? "";
    el.setAttribute(WRAPPER_SPEC_ATTR, wrapperSpecKey(wrapper));
    const host = document.createElement("span");
    host.className = HOST_CLASS;
    el.appendChild(host);
    return el;
  }

  it("keeps a mount whose wrapper still matches the binding", () => {
    expect(wrapperSpecChanged(wrappedMount(ROW_WRAPPER), point(ROW_WRAPPER))).toBe(false);
  });

  it("flags a mount whose surface now wants a different wrapper", () => {
    expect(wrapperSpecChanged(wrappedMount(ROW_WRAPPER), point(PHOTO_WRAPPER))).toBe(true);
    expect(wrapperSpecChanged(wrappedMount(PHOTO_WRAPPER), point(ROW_WRAPPER))).toBe(true);
  });

  it("flags wrapper added or removed against a bare host mount", () => {
    const bareHost = document.createElement("span");
    bareHost.className = HOST_CLASS;
    expect(wrapperSpecChanged(bareHost, point(ROW_WRAPPER))).toBe(true);
    expect(wrapperSpecChanged(wrappedMount(ROW_WRAPPER), point())).toBe(true);
    expect(wrapperSpecChanged(bareHost, point())).toBe(false);
  });
});

// Generic-element fixtures for the mount bookkeeping below.
const TARGET_X1 = { site: "x", targetId: "1", url: "https://x.com/u/status/1" } as const;

function makeHost(): HTMLElement {
  const el = document.createElement("span");
  el.className = HOST_CLASS;
  return el;
}

function pointAt(anchor: HTMLElement, position: PickerInsertionPoint["position"]): PickerInsertionPoint {
  return { anchor, position, target: TARGET_X1 };
}

describe("moveMountNode - idempotent re-positioning", () => {
  it("places and keeps a node after its anchor without duplicating", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const node = makeHost();
    const p = pointAt(anchor, "after");

    moveMountNode(node, p);
    expect(anchor.nextSibling).toBe(node);

    moveMountNode(node, p); // already in place - must not detach/re-append
    expect(anchor.nextSibling).toBe(node);
    expect(document.querySelectorAll(`.${HOST_CLASS}`)).toHaveLength(1);
  });

  it("places before and appends into the anchor", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const before = makeHost();
    moveMountNode(before, pointAt(anchor, "before"));
    expect(anchor.previousSibling).toBe(before);

    const inner = makeHost();
    moveMountNode(inner, pointAt(anchor, "append"));
    expect(inner.parentNode).toBe(anchor);
  });

  it("re-homes a node from a stale surface to the new anchor", () => {
    const oldAnchor = document.createElement("div");
    const newAnchor = document.createElement("div");
    document.body.append(oldAnchor, newAnchor);
    const node = makeHost();
    moveMountNode(node, pointAt(oldAnchor, "after"));
    moveMountNode(node, pointAt(newAnchor, "after"));
    expect(newAnchor.nextSibling).toBe(node);
    expect(oldAnchor.nextSibling).not.toBe(node);
  });
});

describe("clearAdjacentMountNodes - duplicate-host cleanup around an anchor", () => {
  it("removes every adjacent mount node except the one to keep", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const keep = makeHost();
    const dupe = makeHost();
    anchor.after(keep);
    keep.after(dupe);

    clearAdjacentMountNodes(pointAt(anchor, "after"), keep);
    expect(keep.isConnected).toBe(true);
    expect(dupe.isConnected).toBe(false);
  });

  it("walks over ignorable whitespace text nodes between mounts", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const dupe = makeHost();
    anchor.after(document.createTextNode("  \n  "), dupe);

    clearAdjacentMountNodes(pointAt(anchor, "after"));
    expect(dupe.isConnected).toBe(false);
  });

  it("stops at the first page node - never removes past foreign content", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const pageNode = document.createElement("div");
    const shielded = makeHost();
    anchor.after(pageNode);
    pageNode.after(shielded);

    clearAdjacentMountNodes(pointAt(anchor, "after"));
    expect(pageNode.isConnected).toBe(true);
    expect(shielded.isConnected).toBe(true);
  });

  it("clears duplicate children under an append anchor", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const keep = makeHost();
    const dupe = makeHost();
    anchor.append(keep, dupe);

    clearAdjacentMountNodes(pointAt(anchor, "append"), keep);
    expect(keep.isConnected).toBe(true);
    expect(dupe.isConnected).toBe(false);
  });
});

describe("clearStaleAnchorMount - one live mount per anchor across key rewrites", () => {
  afterEach(() => {
    teardownAllMounts();
  });

  it("removes the old key's node still sitting at this point", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const staleNode = makeHost();
    anchor.after(staleNode);
    anchor.setAttribute(MOUNT_ATTR, "x:old");
    registerMountNode(tk("x:old"), staleNode);

    clearStaleAnchorMount(pointAt(anchor, "after"), tk("x:1"));
    expect(staleNode.isConnected).toBe(false);
    expect(mountedNode(tk("x:old")) !== undefined).toBe(false);
  });

  it("drops a disconnected stale entry without touching the DOM", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    anchor.setAttribute(MOUNT_ATTR, "x:old");
    registerMountNode(tk("x:old"), makeHost());

    clearStaleAnchorMount(pointAt(anchor, "after"), tk("x:1"));
    expect(mountedNode(tk("x:old")) !== undefined).toBe(false);
  });

  it("leaves a stale node that is NOT at this point (it belongs to another surface)", () => {
    const anchor = document.createElement("div");
    const elsewhere = document.createElement("div");
    document.body.append(anchor, elsewhere);
    const staleNode = makeHost();
    elsewhere.append(staleNode);
    anchor.setAttribute(MOUNT_ATTR, "x:old");
    registerMountNode(tk("x:old"), staleNode);

    clearStaleAnchorMount(pointAt(anchor, "after"), tk("x:1"));
    expect(staleNode.isConnected).toBe(true);
    expect(mountedNode(tk("x:old")) !== undefined).toBe(true);
  });

  it("cancels a pending lazy mount armed under the old key on this anchor", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    anchor.setAttribute(MOUNT_ATTR, "x:old");
    const observe = vi.fn();
    const unobserve = vi.fn();
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe = observe;
        unobserve = unobserve;
        disconnect = vi.fn();
      },
    );
    try {
      setPendingMount(tk("x:old"), pointAt(anchor, "after"));
      observePendingAnchor(tk("x:old"), anchor);
      expect(observe).toHaveBeenCalledWith(anchor);

      clearStaleAnchorMount(pointAt(anchor, "after"), tk("x:1"));
      expect(pendingMountPoint(tk("x:old"))).toBeUndefined();
      // The shared observer released its strong reference to the anchor.
      expect(unobserve).toHaveBeenCalledWith(anchor);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("is a no-op when the anchor already carries the current key", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    const node = makeHost();
    anchor.after(node);
    anchor.setAttribute(MOUNT_ATTR, "x:1");
    registerMountNode(tk("x:1"), node);

    clearStaleAnchorMount(pointAt(anchor, "after"), tk("x:1"));
    expect(node.isConnected).toBe(true);
    expect(mountedNode(tk("x:1")) !== undefined).toBe(true);
  });
});

describe("isCurrentMountPoint", () => {
  it("true only for a connected anchor carrying the key", () => {
    const anchor = document.createElement("div");
    document.body.append(anchor);
    anchor.setAttribute(MOUNT_ATTR, "x:1");
    expect(isCurrentMountPoint(pointAt(anchor, "after"), tk("x:1"))).toBe(true);
    expect(isCurrentMountPoint(pointAt(anchor, "after"), tk("x:2"))).toBe(false);
    anchor.remove();
    expect(isCurrentMountPoint(pointAt(anchor, "after"), tk("x:1"))).toBe(false);
  });
});

describe("dispatchVoteSync - routes a broadcast to its target's listener only", () => {
  afterEach(() => {
    resetMountRegistryForTests();
  });

  it("invokes the matching listener and nobody else", () => {
    const mine = vi.fn();
    const other = vi.fn();
    setVoteListener(tk("x:1"), mine);
    setVoteListener(tk("x:2"), other);

    const broadcast = { target: TARGET_X1, reaction: "❤️" as const, prevReaction: null };
    dispatchVoteSync(broadcast);
    expect(mine).toHaveBeenCalledWith(broadcast);
    expect(other).not.toHaveBeenCalled();
  });

  it("is silent when no listener is registered", () => {
    expect(() => dispatchVoteSync({ target: TARGET_X1, reaction: null, prevReaction: null })).not.toThrow();
  });
});

// One live mount spans several registries. Dropping it from only one of them
// left the others holding the key - which is exactly what callers used to do,
// because the all-collections teardown was module-private.
describe("dropMount - a mount leaves every registry at once", () => {
  afterEach(() => {
    resetMountRegistryForTests();
  });

  it("takes the vote listener with the node, so a later broadcast reaches nobody", () => {
    const key = tk("x:1");
    const cb = vi.fn();
    registerMountNode(key, makeHost());
    setVoteListener(key, cb);

    dropMount(key);

    expect(mountedNode(key)).toBeUndefined();
    dispatchVoteSync({ target: TARGET_X1, reaction: "❤️", prevReaction: null });
    expect(cb).not.toHaveBeenCalled();
  });

  it("releases the anchor's mount claim, so the slot is free for the next key", () => {
    const key = tk("x:1");
    const anchor = document.createElement("div");
    document.body.appendChild(anchor);
    registerMountNode(key, makeHost());
    claimMountAnchor(anchor, key);

    dropMount(key);

    expect(anchor.hasAttribute(MOUNT_ATTR)).toBe(false);
    anchor.remove();
  });

  it("prunes a node that was inserted but never finished its render", () => {
    // insertAndSpace registers the node; renderPicker completes it. A mount that
    // dies in between is still a detached node holding a registry slot, and the
    // prune walk has to see it.
    const key = tk("x:half-rendered");
    registerMountNode(key, makeHost());

    pruneDisconnected();

    expect(mountedNode(key)).toBeUndefined();
  });
});

describe("removeMountNode / hostElementOfMount", () => {
  it("finds the host on a bare mount and inside a wrapper; null for foreign nodes", () => {
    const bare = makeHost();
    expect(hostElementOfMount(bare)).toBe(bare);

    const wrapper = document.createElement("div");
    const inner = makeHost();
    wrapper.append(inner);
    expect(hostElementOfMount(wrapper)).toBe(inner);

    expect(hostElementOfMount(document.createElement("div"))).toBe(null);
    expect(hostElementOfMount(document.createTextNode("x"))).toBe(null);
  });

  it("detaches the node, including a host with an open shadow root", () => {
    const host = makeHost();
    host.attachShadow({ mode: "open" });
    document.body.append(host);
    removeMountNode(host);
    expect(host.isConnected).toBe(false);
  });
});
