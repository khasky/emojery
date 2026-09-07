// SPDX-License-Identifier: GPL-3.0-or-later
//
// The one place that decides the user has actually LOOKED at a trigger, for the
// onboarding checklist's "spot the button" step.
//
// Deliberately stricter than the coach-mark's own latch. A fresh install replays
// the content scripts into every already-open supported tab, and `visibilityState`
// alone calls the active tab of a second, unfocused window "visible" - so that
// latch gets spent, and the step used to tick, without a button ever being in front
// of anyone. Four conditions have to hold TOGETHER, and hold for LOOKED_AT_MS
// without a break: the step is armed (shared/onboarding.ts - the checklist page has
// been on screen), the tab is visible, the window has focus, and a trigger is
// intersecting the viewport at a size the user can see.

import { markTriggerSeen, readTriggerSeen, type TriggerSeenState, watchOnboardingFlags } from "../shared/onboarding";
import { logContentError } from "./debug";

// A glance, not a scroll past. Also long enough that the install's own replay -
// which lands while the user is still on chrome://extensions or the checklist -
// cannot satisfy it by accident.
const LOOKED_AT_MS = 1_000;

const WINDOW_EVENTS = ["focus", "blur"] as const;

// Every mounted host on this page while the step is still owed; the observer
// decides which of them are on screen right now.
const hosts = new Set<HTMLElement>();
const onScreen = new Set<HTMLElement>();
let observer: IntersectionObserver | null = null;
let timer: number | undefined;
let listening = false;
// The single storage read per page. `settled` covers both endings: the step was
// earned (here or in another tab), and the engine has no IntersectionObserver.
let started = false;
let settled = false;
let unwatchArming: (() => void) | null = null;

export function __resetTriggerSeenForTest(): void {
  stop();
  hosts.clear();
  onScreen.clear();
  started = false;
  settled = false;
}

/** Called for every mount. Cheap after the first one, and free once the step is settled. */
export function watchTriggerSeen(host: HTMLElement): void {
  if (settled) return;
  hosts.add(host);
  observer?.observe(host);
  if (started) return;
  started = true;
  void begin().catch((error: unknown) => logContentError("watchTriggerSeen", error));
}

/** The registry drops hosts here as it recycles them; an observed host that left the DOM is a leak. */
export function forgetTriggerSeenHost(host: HTMLElement): void {
  if (!hosts.delete(host)) return;
  observer?.unobserve(host);
  onScreen.delete(host);
  sync();
}

async function begin(): Promise<void> {
  apply(await readTriggerSeen());
}

function apply(state: TriggerSeenState): void {
  if (state === "seen") {
    stop();
    return;
  }
  if (state === "armed") {
    unwatchArming?.();
    unwatchArming = null;
    startWatching();
    return;
  }
  // Not armed yet. The install opens the checklist in the same breath as it
  // replays this content script, so the arming is usually a moment away - waiting
  // for it costs one storage listener, while writing the step off would strand it
  // for the life of the tab.
  unwatchArming ??= watchOnboardingFlags(() => void onArmingChange().catch((error: unknown) => logContentError("triggerSeenArming", error)));
}

async function onArmingChange(): Promise<void> {
  if (settled) return;
  apply(await readTriggerSeen());
}

function startWatching(): void {
  if (settled || listening) return;
  listening = true;
  // No IntersectionObserver, no proof of a look: leave the step untouched rather
  // than tick it on a mount alone, which is the bug this module exists for.
  if (typeof IntersectionObserver === "undefined") {
    stop();
    return;
  }
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const host = entry.target as HTMLElement;
      if (entry.isIntersecting) onScreen.add(host);
      else onScreen.delete(host);
    }
    sync();
  });
  for (const host of hosts) observer.observe(host);
  for (const event of WINDOW_EVENTS) window.addEventListener(event, sync);
  document.addEventListener("visibilitychange", sync);
  sync();
}

function looking(): boolean {
  if (document.visibilityState !== "visible" || !document.hasFocus()) return false;
  for (const host of onScreen) {
    // IntersectionObserver sees `visibility: hidden` as visible, and a host is held
    // exactly that way (mount-style.ts's sizing attribute) until its glyph is measured.
    if (host.isConnected && getComputedStyle(host).visibility !== "hidden") return true;
  }
  return false;
}

function sync(): void {
  if (settled) return;
  if (!looking()) {
    clearTimer();
    return;
  }
  if (timer !== undefined) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    if (looking()) void earn().catch((error: unknown) => logContentError("markTriggerSeen", error));
  }, LOOKED_AT_MS);
}

async function earn(): Promise<void> {
  if (settled) return;
  const state = await readTriggerSeen();
  // Still unarmed: the checklist page lost the race. Keep the watch and let the
  // next tick of `sync` try again.
  if (state === "off") {
    sync();
    return;
  }
  if (state === "armed") await markTriggerSeen();
  stop();
}

function clearTimer(): void {
  if (timer === undefined) return;
  window.clearTimeout(timer);
  timer = undefined;
}

function stop(): void {
  settled = true;
  clearTimer();
  observer?.disconnect();
  observer = null;
  hosts.clear();
  onScreen.clear();
  unwatchArming?.();
  unwatchArming = null;
  if (!listening) return;
  listening = false;
  for (const event of WINDOW_EVENTS) window.removeEventListener(event, sync);
  document.removeEventListener("visibilitychange", sync);
}
