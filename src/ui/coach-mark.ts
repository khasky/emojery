// SPDX-License-Identifier: GPL-3.0-or-later
//
// One-time coach-mark on the first live trigger: a pulse ring on the trigger
// plus a small tooltip in the overlay root, shown once per install (a
// storage.local latch - shared/onboarding.ts) and never again after any
// dismissal. This is injected UI on a foreign page, so every boundary is
// deliberately tight: one shot, quiet animation (none under reduced-motion),
// and it yields to a click, Escape, a scroll, or a timeout.

import { COACH_ATTR, COUNTER_CLASS, TRIGGER_CLASS } from "../shared/dom";
import { t } from "../shared/i18n";
import { claimCoachMark } from "../shared/onboarding";
import { getOverlayRoot } from "./mount-shadow";

// Let mount.ts's early re-blend passes land before pointing at the trigger.
// Deliberately SHORTER than its SIZING_REVEAL_DEADLINE_MS forced reveal, so a host
// still held invisible by SIZING_ATTR can be pointed at: the only visibility guard on
// that path is maybeShowCoachMark's zero-rect check before it calls showCoachMark,
// and `visibility: hidden` does not produce a zero rect.
const COACH_SHOW_DELAY_MS = 800;
// The mark is only a hint: it leaves on its own.
const COACH_TIMEOUT_MS = 15_000;
// Sites nudge their scroll position while settling; only a scroll after this
// grace period reads as the user moving on.
const COACH_SCROLL_GRACE_MS = 1_000;
const COACH_TIP_WIDTH_PX = 260;
const COACH_TIP_GAP_PX = 10;
const COACH_VIEWPORT_MARGIN_PX = 8;

// One attempt per page load, whatever the outcome - a feed mounting 30 triggers
// must not race 30 claims.
let attemptedOnThisPage = false;

export function __resetCoachMarkForTest(): void {
  attemptedOnThisPage = false;
}

// A mount in a background tab is not something the user witnessed. The install
// replays content scripts into every already-open supported tab
// (background/install.ts), so claiming there would spend the one-shot on a
// tooltip nobody sees - and tick the onboarding page's "spot the button" step for
// a button that was never on screen. Resolves at once when the tab is visible.
function whenVisible(): Promise<void> {
  if (document.visibilityState === "visible") return Promise.resolve();
  return new Promise((resolve) => {
    const onChange = (): void => {
      if (document.visibilityState !== "visible") return;
      document.removeEventListener("visibilitychange", onChange);
      resolve();
    };
    document.addEventListener("visibilitychange", onChange);
  });
}

export async function maybeShowCoachMark(host: HTMLElement): Promise<void> {
  if (attemptedOnThisPage) return;
  attemptedOnThisPage = true;
  const trigger = host.shadowRoot?.querySelector<HTMLElement>(`.${TRIGGER_CLASS}, .${COUNTER_CLASS}`);
  if (!trigger) return;
  await whenVisible();
  // The wait can outlive the mount - a feed recycles cards, and a tab can sit
  // hidden for hours before it is looked at.
  if (!host.isConnected || !trigger.isConnected) return;
  if (!(await claimCoachMark())) return;
  // Claimed but the host may die before the delay fires; the claim stays spent -
  // a coach-mark that reappears later on some other page would read as a bug.
  window.setTimeout(() => {
    if (!host.isConnected || !trigger.isConnected) return;
    const rect = trigger.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    showCoachMark(host, rect);
  }, COACH_SHOW_DELAY_MS);
}

function showCoachMark(host: HTMLElement, rect: DOMRect): void {
  host.setAttribute(COACH_ATTR, "1");
  const tip = buildTip();
  getOverlayRoot().appendChild(tip);
  positionTip(tip, rect);

  const shownAt = Date.now();
  const timer = window.setTimeout(dismiss, COACH_TIMEOUT_MS);

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") dismiss();
  }
  // Any interaction with the trigger is the mission accomplished - the picker
  // (or the sign-in gate) takes over from here.
  function onHostInteract(): void {
    dismiss();
  }
  function onScroll(): void {
    if (Date.now() - shownAt >= COACH_SCROLL_GRACE_MS) dismiss();
  }

  function dismiss(): void {
    window.clearTimeout(timer);
    tip.remove();
    host.removeAttribute(COACH_ATTR);
    document.removeEventListener("keydown", onKeydown, true);
    window.removeEventListener("scroll", onScroll, true);
    host.removeEventListener("pointerdown", onHostInteract, true);
    host.removeEventListener("keydown", onHostInteract, true);
  }

  tip.querySelector("button")?.addEventListener("click", dismiss);
  document.addEventListener("keydown", onKeydown, true);
  // Capture catches the inner scroll containers some sites scroll instead of the window.
  window.addEventListener("scroll", onScroll, { capture: true, passive: true });
  host.addEventListener("pointerdown", onHostInteract, true);
  host.addEventListener("keydown", onHostInteract, true);
}

// role="status" (polite announcement), not a dialog: nothing is trapped and the
// page keeps keyboard focus.
function buildTip(): HTMLElement {
  const tip = document.createElement("div");
  tip.className = "khasky-emojery-coach-tip";
  tip.setAttribute("role", "status");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "khasky-emojery-coach-close";
  close.setAttribute("aria-label", t("coachDismissAria"));
  close.textContent = "✕";
  const title = document.createElement("p");
  title.className = "khasky-emojery-coach-title";
  title.textContent = t("coachTitle");
  const body = document.createElement("p");
  body.className = "khasky-emojery-coach-body";
  body.textContent = t("coachBody");
  tip.append(close, title, body);
  return tip;
}

// Below the trigger, clamped into the viewport. Positioned once - a page that
// scrolls afterwards dismisses the mark (onScroll) rather than dragging it around.
function positionTip(tip: HTMLElement, rect: DOMRect): void {
  const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
  const left = Math.max(COACH_VIEWPORT_MARGIN_PX, Math.min(rect.left, viewportWidth - COACH_TIP_WIDTH_PX - COACH_VIEWPORT_MARGIN_PX));
  tip.style.width = `${COACH_TIP_WIDTH_PX}px`;
  tip.style.left = `${left}px`;
  tip.style.top = `${rect.bottom + COACH_TIP_GAP_PX}px`;
}
