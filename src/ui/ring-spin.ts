// SPDX-License-Identifier: GPL-3.0-or-later
//
// The trigger's RGB ring animation: which hosts are allowed to spin, and which
// of those currently do. Self-contained - it shares nothing with the mount
// registry but the moment a host is dropped (see forgetRingHost / pruneRingHosts,
// called from ui/mount-registry.ts).

// Gates the RGB ring's CSS spin (picker.css). Set only while the ring's host is BOTH allowed
// to animate (the Reaction-animations setting) and actually on screen.
const ANIMATE_ATTR = "data-khasky-emojery-animate";
// The spin is a GREETING, not a permanent state: the masked, overflow-clipped ring box is
// GPU-re-rastered every frame it turns, the extension's largest idle cost (why the mask is
// there: picker.css `.khasky-emojery-ring`; the measured figures: ring-spin.test.ts).
// So each host spins for a bounded window whenever it comes into view and re-arms when the user
// points at or focuses it - present every time a user looks at a trigger, free on a parked tab.
export const RING_SPIN_WINDOW_MS = 8_000;
// Hosts the setting allows to spin; the observer below decides which of them currently do.
const ringHosts = new Set<HTMLElement>();
const ringSpinTimers = new WeakMap<HTMLElement, number>();
let ringVisibility: IntersectionObserver | null = null;

function startRingSpin(host: HTMLElement): void {
  const running = ringSpinTimers.get(host);
  if (running !== undefined) window.clearTimeout(running);
  host.setAttribute(ANIMATE_ATTR, "");
  ringSpinTimers.set(
    host,
    window.setTimeout(() => {
      ringSpinTimers.delete(host);
      host.removeAttribute(ANIMATE_ATTR);
    }, RING_SPIN_WINDOW_MS),
  );
}

function stopRingSpin(host: HTMLElement): void {
  const running = ringSpinTimers.get(host);
  if (running !== undefined) {
    window.clearTimeout(running);
    ringSpinTimers.delete(host);
  }
  host.removeAttribute(ANIMATE_ATTR);
}

// Pointing at or focusing a trigger re-arms its window - the spin is back exactly when
// the user is looking at that button.
function onRingWake(event: Event): void {
  const host = event.currentTarget;
  if (host instanceof HTMLElement && ringHosts.has(host)) startRingSpin(host);
}

const RING_WAKE_EVENTS = ["pointerenter", "focusin"] as const;

// Lazy: null on an engine without IntersectionObserver, which setRingAnimation treats as "spin now".
function ringVisibilityObserver(): IntersectionObserver | null {
  if (typeof IntersectionObserver === "undefined") return null;
  ringVisibility ??= new IntersectionObserver((entries) => {
    for (const entry of entries) {
      const host = entry.target as HTMLElement;
      if (!ringHosts.has(host)) continue;
      if (entry.isIntersecting) startRingSpin(host);
      else stopRingSpin(host);
    }
  });
  return ringVisibility;
}

export function setRingAnimation(host: HTMLElement, enabled: boolean): void {
  if (!enabled) {
    forgetRingHost(host);
    return;
  }
  if (ringHosts.has(host)) return;
  ringHosts.add(host);
  for (const event of RING_WAKE_EVENTS) host.addEventListener(event, onRingWake);
  const observer = ringVisibilityObserver();
  if (observer) observer.observe(host);
  else startRingSpin(host);
}

export function forgetRingHost(host: HTMLElement): void {
  ringHosts.delete(host);
  ringVisibility?.unobserve(host);
  for (const event of RING_WAKE_EVENTS) host.removeEventListener(event, onRingWake);
  stopRingSpin(host);
}

/** Drop hosts that left the document. IntersectionObserver keeps a strong
 *  reference to what it observes, so an unpruned host is a leak. */
export function pruneRingHosts(): void {
  for (const el of ringHosts) {
    if (!el.isConnected) forgetRingHost(el);
  }
}
