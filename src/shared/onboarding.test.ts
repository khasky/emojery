// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { armTriggerSeen, claimCoachMark, hasReactedOnce, hasSeenTrigger, isOnboardingBadgeActive, markCoachSeen, markTriggerSeen, readTriggerSeen, resetOnboardingLatches, setOnboardingBadgeActive, watchOnboardingFlags } from "./onboarding";

let shim: ChromeShimHandle;

beforeEach(() => {
  shim = installChromeShim();
});

afterEach(() => {
  shim.uninstall();
});

describe("coach-mark latch", () => {
  it("claims exactly once, then stays spent", async () => {
    expect(await claimCoachMark()).toBe(true);
    expect(await claimCoachMark()).toBe(false);
  });

  it("markCoachSeen spends the claim without showing", async () => {
    await markCoachSeen();
    expect(await claimCoachMark()).toBe(false);
  });
});

describe("onboarding badge flag", () => {
  // Installs that predate the flag must never grow a dot on update.
  it("absent means inactive", async () => {
    expect(await isOnboardingBadgeActive()).toBe(false);
  });

  it("latches on and back off", async () => {
    await setOnboardingBadgeActive(true);
    expect(await isOnboardingBadgeActive()).toBe(true);
    await setOnboardingBadgeActive(false);
    expect(await isOnboardingBadgeActive()).toBe(false);
  });
});

describe("spot-the-button latch", () => {
  it("stays out of play until the checklist page arms it", async () => {
    expect(await readTriggerSeen()).toBe("off");
    expect(await hasSeenTrigger()).toBe(false);
  });

  it("arms, then earns", async () => {
    await armTriggerSeen();
    expect(await readTriggerSeen()).toBe("armed");
    expect(await hasSeenTrigger()).toBe(false);

    await markTriggerSeen();
    expect(await hasSeenTrigger()).toBe(true);
  });

  // A second visit to the checklist page must not un-tick a step already earned.
  it("re-arming leaves an earned step alone", async () => {
    await armTriggerSeen();
    await markTriggerSeen();
    await armTriggerSeen();
    expect(await readTriggerSeen()).toBe("seen");
  });

  // Why the two latches are separate at all: the install replays its content
  // scripts into every open supported tab, and the first of those mounts spends
  // the coach-mark - on a page nobody was looking at.
  it("is untouched by the coach-mark latch", async () => {
    await claimCoachMark();
    await markCoachSeen();
    expect(await hasSeenTrigger()).toBe(false);
  });
});

// What the onboarding page's checklist reads. Both are derived from latches other
// parts of the extension already write - nothing is recorded just for the page.
describe("checklist signals", () => {
  it("reads the first reaction off the badge latch retiring", async () => {
    await setOnboardingBadgeActive(true);
    expect(await hasReactedOnce()).toBe(false);
    await setOnboardingBadgeActive(false);
    expect(await hasReactedOnce()).toBe(true);
  });

  // An install that predates the flag never armed the dot; that must read as
  // "not reacted" rather than tick a step the user never did.
  it("treats a missing badge latch as not reacted", async () => {
    expect(await hasReactedOnce()).toBe(false);
  });
});

// A reinstall keeps extension storage - see resetOnboardingLatches in onboarding.ts.
describe("resetOnboardingLatches", () => {
  it("hands a reinstall an untouched checklist and an unspent coach-mark", async () => {
    await markCoachSeen();
    await markTriggerSeen();
    await setOnboardingBadgeActive(false);

    await resetOnboardingLatches();

    expect(await hasSeenTrigger()).toBe(false);
    expect(await readTriggerSeen(), "the step is out of play until the new install's page arms it").toBe("off");
    expect(await hasReactedOnce()).toBe(false);
    expect(await isOnboardingBadgeActive()).toBe(false);
    expect(await claimCoachMark(), "the coach-mark is owed again").toBe(true);
  });
});

describe("watchOnboardingFlags", () => {
  it("fires on either checklist latch and stops after unsubscribing", () => {
    let calls = 0;
    const unwatch = watchOnboardingFlags(() => {
      calls++;
    });

    shim.emitChanged("local", { trigger_seen_v1: { newValue: true } });
    shim.emitChanged("local", { onboarding_badge_v1: { newValue: false } });
    expect(calls).toBe(2);

    // Unrelated keys and the sync area must not wake the page. The coach-mark is
    // one of those now: no step reads it.
    shim.emitChanged("local", { coach_seen_v1: { newValue: true } });
    shim.emitChanged("local", { settings: { newValue: {} } });
    shim.emitChanged("sync", { trigger_seen_v1: { newValue: true } });
    expect(calls).toBe(2);

    unwatch();
    shim.emitChanged("local", { trigger_seen_v1: { newValue: true } });
    expect(calls).toBe(2);
  });
});
