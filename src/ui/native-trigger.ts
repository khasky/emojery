// SPDX-License-Identifier: GPL-3.0-or-later
//
// "Auto-press native buttons": mirror a picked emoji to the site's native
// control. Split into a PURE decision (`decideNativeTrigger`, unit-tested
// matrix) and an impure executor (`autoPressNative`) that reads state, clicks,
// and books what WE pressed into the auto-native store - so un-react/neutral
// only ever un-presses our own press, never a like the user set by hand.
//
// Live-verified constraints this module encodes (see e2e/site-auth):
// - untrusted el.click() works on every supported like/dislike control, even
//   one hidden by "Hide original buttons" (display:none) - but never on a
//   detached node, hence the isConnected guards;
// - Facebook's flyout opens only after a leave->enter hover reset and its items
//   ignore bare click() - they need the full pointer press sequence;
// - pressing a toggle that is already in the desired state would UNDO it, so
//   an unknown pressed-state refuses to press rather than risk a double-toggle.
import type { NativeVoteActions, PickerInsertionPoint } from "../shared/adapter";
import { HOST_CLASS, OVERLAY_HOST_CLASS } from "../shared/dom";
import { type FbReaction, type NativeAutoAction, resolveFbReaction, resolveSentiment } from "../shared/native-actions";
import type { Reaction } from "../shared/reactions";
import { getAutoNative, setAutoNative } from "../shared/storage";
import { readContentSettings } from "./settings-cache";

type FbReactionMenu = NonNullable<NativeVoteActions["reactionMenu"]>;

type NativeTriggerDecision =
  | { kind: "none" }
  | { kind: "press-like" }
  | { kind: "press-dislike" }
  /** Undo our recorded press (click the control that is still pressed). */
  | { kind: "unpress"; recorded: NativeAutoAction }
  /** Drive Facebook's flyout to the reaction at `fb.index`. */
  | { kind: "fb-reaction"; fb: FbReaction };

export interface NativeTriggerInput {
  /** The picked emoji, or null on un-react. */
  reaction: Reaction | null;
  sentiment: "positive" | "negative" | "neutral";
  /** Exact FB mapping for the picked emoji (null when none / not FB). */
  fbMatch: FbReaction | null;
  hasLike: boolean;
  hasDislike: boolean;
  hasFbMenu: boolean;
  /** Pressed state of the native like / dislike; null = unknown. */
  likePressed: boolean | null;
  dislikePressed: boolean | null;
  /** What WE pressed for this target earlier (auto-native store). */
  recorded: NativeAutoAction | null;
}

// The full matrix. Ordering matters: un-react first, FB exact match beats the
// sentiment lists, neutral only cleans up after ourselves.
export function decideNativeTrigger(input: NativeTriggerInput): NativeTriggerDecision {
  const { reaction, sentiment, fbMatch, hasLike, hasDislike, hasFbMenu, likePressed, dislikePressed, recorded } = input;

  if (reaction === null) {
    return recorded ? { kind: "unpress", recorded } : { kind: "none" };
  }

  if (hasFbMenu) {
    // Plain-positive on FB rides the flyout's own Like entry (index 0), so a
    // switch from a previous flyout reaction lands in ONE interaction.
    const desired = fbMatch ?? (sentiment === "positive" ? resolveFbReaction("👍") : null);
    if (desired) {
      // A plain-Like record (flyout fallback) equals the flyout's Like entry.
      const recordedKey = recorded === "like" ? "fb:like" : recorded;
      // "Already pressed" only holds while the control still SHOWS a reaction: a record can
      // outlive its press (cleared on facebook.com, or a run abandoned between press and
      // release), and trusting it made that emoji a permanent no-op. An unknown state still
      // defers to the record; only a control that reads NOT pressed re-drives the flyout.
      if (recordedKey === `fb:${desired.name}` && likePressed !== false) return { kind: "none" };
      // Not recorded but the button already shows a pressed reaction the user
      // set manually: leave it alone.
      if (!recorded && likePressed === true) return { kind: "none" };
      return { kind: "fb-reaction", fb: desired };
    }
    return recorded ? { kind: "unpress", recorded } : { kind: "none" };
  }

  if (sentiment === "positive") {
    if (hasLike) {
      if (likePressed === true) return { kind: "none" };
      // Unknown state: press only when undoing our own recorded dislike - a
      // fresh press on an unknown toggle risks undoing a manual like.
      if (likePressed === null && recorded !== "dislike") return { kind: "none" };
      return { kind: "press-like" };
    }
    // Dislike-only row: a positive emoji presses nothing, but our own earlier
    // auto-dislike no longer matches the sentiment - take it back. Mirrors the
    // like-only case below; reachable because reddit.ts fills `like` and `dislike`
    // independently from whichever controls it finds on the row.
    return recorded ? { kind: "unpress", recorded } : { kind: "none" };
  }

  if (sentiment === "negative") {
    if (hasDislike) {
      if (dislikePressed === true) return { kind: "none" };
      if (dislikePressed === null && recorded !== "like") return { kind: "none" };
      return { kind: "press-dislike" };
    }
    // Like-only site: a negative emoji presses nothing, but our own earlier
    // auto-like no longer matches the sentiment - take it back.
    return recorded ? { kind: "unpress", recorded } : { kind: "none" };
  }

  if (sentiment === "neutral") {
    return recorded ? { kind: "unpress", recorded } : { kind: "none" };
  }

  // Unreachable: the three sentiments above are the whole union. Kept so a widened
  // union compiles here instead of falling through to an undefined decision.
  return { kind: "none" };
}

// Generic pressed-state read: adapter override first, then the locale-free
// signals (aria-pressed, X's data-testid, GitHub's star/unstar form action).
export function readPressed(el: HTMLElement | undefined, override?: () => boolean | null): boolean | null {
  if (!el) return null;
  if (override) {
    const pressed = override();
    if (pressed !== null) return pressed;
  }
  const ariaPressed = el.getAttribute("aria-pressed") ?? el.querySelector("[aria-pressed]")?.getAttribute("aria-pressed") ?? null;
  if (ariaPressed === "true") return true;
  if (ariaPressed === "false") return false;
  const testid = el.getAttribute("data-testid");
  if (testid === "unlike") return true;
  if (testid === "like") return false;
  const formAction = el.closest("form")?.getAttribute("action") ?? "";
  if (formAction.endsWith("/unstar")) return true;
  if (formAction.endsWith("/star")) return false;
  return null;
}

// Facebook flyout driver. Protocol verified live (2026-08): re-hover needs a
// leave reset first; the flyout takes FB's hover-intent ~0.5-2s to appear; its
// items ignore bare click() and need the full pointer press sequence; on a
// successful pick the flyout dismisses itself.

const FB_LEAVE_SETTLE_MS = 250;
const FB_FLYOUT_TIMEOUT_MS = 3500;
const FB_POLL_STEP_MS = 150;
const FB_PRESS_HOVER_MS = 120;
const FB_PRESS_HOLD_MS = 60;
// Prewarm: how long an open picker keeps the flyout hover alive, and the
// grace before an abandoned prewarm dismisses the flyout it opened.
const FB_PREWARM_MAX_MS = 30_000;
const FB_PREWARM_DISMISS_DELAY_MS = 1200;
// Keepalive tick once the flyout is already showing: only the hover state has to stay
// alive then, so it re-enters slower than the pre-flyout poll.
const FB_PREWARM_KEEPALIVE_MS = 400;

type PointerCtor = typeof PointerEvent | typeof MouseEvent;

function fire(el: HTMLElement, type: string, Ctor: PointerCtor, pos: { clientX: number; clientY: number }, bubbles: boolean): void {
  el.dispatchEvent(new Ctor(type, { bubbles, cancelable: true, composed: true, ...pos }));
}

function centerOf(el: HTMLElement): { clientX: number; clientY: number } {
  const rect = el.getBoundingClientRect();
  return { clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 };
}

function dispatchLeave(el: HTMLElement): void {
  const away = { clientX: 0, clientY: 0 };
  fire(el, "pointerout", PointerEvent, away, true);
  fire(el, "pointerleave", PointerEvent, away, false);
  fire(el, "mouseout", MouseEvent, away, true);
  fire(el, "mouseleave", MouseEvent, away, false);
}

function dispatchEnter(el: HTMLElement): void {
  const mid = centerOf(el);
  fire(el, "pointerover", PointerEvent, mid, true);
  fire(el, "pointerenter", PointerEvent, mid, false);
  fire(el, "mouseover", MouseEvent, mid, true);
  fire(el, "mouseenter", MouseEvent, mid, false);
  fire(el, "mousemove", MouseEvent, mid, true);
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Hold the hover open until the flyout renders. A single enter is NOT enough
// after a picker click: the user's REAL cursor still sits where they clicked,
// and when the picker overlay unmounts Chrome fires a trusted pointerover on
// whatever is under it - which reads to FB as "the mouse left the Like button"
// and cancels its hover-intent timer (verified live: one synthetic enter never
// opened the flyout after a picker click; the same enter with no prior real
// mouse activity opened it in <1s). Re-entering on every poll tick restarts
// the intent; a second full leave->enter round is the fallback reset.
async function openFbFlyout(menu: FbReactionMenu): Promise<HTMLElement[] | null> {
  const trigger = menu.trigger;
  // Prewarmed path: the picker-open hover (startFbPrewarm) usually has the
  // flyout already showing - pick from it directly, skipping every delay.
  const warm = menu.findMenu();
  if (warm) return warm;
  for (let attempt = 0; attempt < 2; attempt++) {
    dispatchLeave(trigger);
    await delay(FB_LEAVE_SETTLE_MS);
    const deadline = Date.now() + FB_FLYOUT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      dispatchEnter(trigger);
      await delay(FB_POLL_STEP_MS);
      const buttons = menu.findMenu();
      if (buttons) return buttons;
    }
  }
  return null;
}

// Open the flyout and press the reaction at `fb.index`. False = the flyout
// never appeared or lacked the slot; the caller decides the fallback. A failed
// pick ends with a leave so the abandoned flyout does not linger (Escape does
// not close it - verified live); a successful one dismisses the flyout itself.
async function pickFbReaction(menu: FbReactionMenu, index: number): Promise<boolean> {
  const trigger = menu.trigger;
  if (!trigger.isConnected) return false;
  fbPickInFlight = true;
  try {
    const buttons = await openFbFlyout(menu);
    const btn = buttons?.[index];
    if (!btn?.isConnected) {
      dispatchLeave(trigger);
      return false;
    }
    dispatchEnter(btn);
    await delay(FB_PRESS_HOVER_MS);
    const mid = centerOf(btn);
    fire(btn, "pointerdown", PointerEvent, mid, true);
    fire(btn, "mousedown", MouseEvent, mid, true);
    await delay(FB_PRESS_HOLD_MS);
    fire(btn, "pointerup", PointerEvent, mid, true);
    fire(btn, "mouseup", MouseEvent, mid, true);
    fire(btn, "click", MouseEvent, mid, true);
    return true;
  } finally {
    fbPickInFlight = false;
  }
}

// Facebook's flyout, and only Facebook's: the protocol above (leave->enter reset, pointer
// press sequence, flyout-position index) is FB's own behaviour, not a generic "this site has
// a reaction menu" capability. Gating on the `kind` discriminator rather than the field's mere
// presence means a second site's menu gets no press until its protocol lands - and widening
// that union makes the compiler point at this line.
function fbReactionMenu(nv: NativeVoteActions | undefined): FbReactionMenu | null {
  const menu = nv?.reactionMenu;
  return menu?.kind === "facebook" ? menu : null;
}

// Flyout prewarm: the hover-intent delay is FB's own timer, so the
// only way a pick can feel instant is to start that timer EARLY - while the
// picker is open and the user is still choosing an emoji. mount.ts wires these
// to the picker's open/close (Picker onOpenChange).

let prewarmToken = 0;
// The point whose picker started the live prewarm; a stop only counts from that same point.
// mount.ts wires onOpenChange to EVERY mounted picker and Preact fires it once on mount with
// `open === false`, so without this owner check a post scrolling into a feed cancelled the
// keepalive - and the press shield - under an open picker.
let prewarmOwner: PickerInsertionPoint | null = null;
let fbPickInFlight = false;
// A pick is requested but has not reached pickFbReaction yet. Picker.handlePick calls
// setOpen(false) BEFORE awaiting onPick, so stopFbPrewarm always runs first and cannot see the
// pick coming from `fbPickInFlight` alone; vote-client sets this synchronously, ahead of its
// first await, so a close WITHOUT a pick dismisses the flyout at once.
let fbPickPending = false;

export function setFbPickPending(pending: boolean): void {
  fbPickPending = pending;
}

// While the prewarm is live, the user's REAL click on a picker emoji would
// close the prewarmed flyout before the engine can press it: FB dismisses on
// the trusted mousedown, which fires long before our (async) pick starts.
// Shield exactly those press-start events whose path runs through OUR picker
// UI - capture on document runs before FB's delegated handlers, and the
// picker itself acts on `click`, which is left untouched.
function installPickerPressShield(): () => void {
  const shield = (e: Event) => {
    const path = e.composedPath();
    if (path.some((n) => n instanceof HTMLElement && (n.classList.contains(OVERLAY_HOST_CLASS) || n.classList.contains(HOST_CLASS)))) {
      e.stopPropagation();
    }
  };
  document.addEventListener("pointerdown", shield, true);
  document.addEventListener("mousedown", shield, true);
  return () => {
    document.removeEventListener("pointerdown", shield, true);
    document.removeEventListener("mousedown", shield, true);
  };
}

export function startFbPrewarm(point: PickerInsertionPoint): void {
  const menu = fbReactionMenu(point.nativeVote);
  if (!menu) return;
  const token = ++prewarmToken;
  // Claimed synchronously so a close that lands before the settings read still
  // resolves as this point's own stop.
  prewarmOwner = point;
  void (async () => {
    try {
      const settings = await readContentSettings();
      if (!settings.autoTriggerNative || token !== prewarmToken) return;
      const trigger = menu.trigger;
      if (!trigger.isConnected) return;
      const removeShield = installPickerPressShield();
      try {
        dispatchLeave(trigger);
        await delay(FB_LEAVE_SETTLE_MS);
        const until = Date.now() + FB_PREWARM_MAX_MS;
        // Keepalive against the user's real cursor (same reason as openFbFlyout);
        // once the flyout shows, slower ticks just keep the hover state alive.
        while (token === prewarmToken && Date.now() < until) {
          if (!trigger.isConnected) return;
          dispatchEnter(trigger);
          await delay(menu.findMenu() ? FB_PREWARM_KEEPALIVE_MS : FB_POLL_STEP_MS);
        }
      } finally {
        removeShield();
      }
    } finally {
      // Release on EVERY exit (setting off, trigger gone, window elapsed), or a
      // picker whose host was torn down while open would hold the claim forever
      // and block the next picker's stop.
      if (prewarmOwner === point) prewarmOwner = null;
    }
  })().catch(() => {});
}

// Closing the picker abandons the prewarm; dismiss the flyout it opened.
// Immediately when no pick is coming - the reactions bar is then purely our
// artifact, and leaving it up read as the picker refusing to close (a stray
// native bar lingering ~1-2s after a click-outside). A pick that is pending or
// mid-flight keeps the grace period so the flyout is never yanked out from
// under it.
export function stopFbPrewarm(point: PickerInsertionPoint): void {
  const menu = fbReactionMenu(point.nativeVote);
  if (!menu) return;
  if (prewarmOwner !== point) return;
  prewarmOwner = null;
  prewarmToken++;
  if (!fbPickPending && !fbPickInFlight) {
    if (menu.findMenu()) dispatchLeave(menu.trigger);
    return;
  }
  setTimeout(() => {
    if (!fbPickInFlight && menu.findMenu()) dispatchLeave(menu.trigger);
  }, FB_PREWARM_DISMISS_DELAY_MS);
}

// Executor.

interface NativeTriggerDeps {
  press: (el: HTMLElement) => void;
  pickFb: typeof pickFbReaction;
}

const defaultDeps: NativeTriggerDeps = {
  press: (el) => el.click(),
  pickFb: pickFbReaction,
};

// Fire-and-forget entry, called from the vote flow on the optimistic path.
// Never throws into the caller; a failed press is a silently missing
// enhancement, the Emojery vote itself already went through.
export function autoPressNative(point: PickerInsertionPoint, reaction: Reaction | null, userId: string): void {
  void runAutoPress(point, reaction, userId, defaultDeps)
    .catch(() => {})
    // The pick has run its course (pressed, skipped, or failed) - a later picker
    // close is no longer covering for it and may dismiss the flyout at once.
    .finally(() => setFbPickPending(false));
}

export async function runAutoPress(point: PickerInsertionPoint, reaction: Reaction | null, userId: string, deps: NativeTriggerDeps): Promise<void> {
  const nv = point.nativeVote;
  const fbMenu = fbReactionMenu(nv);
  if (!nv || (!nv.like && !nv.dislike && !fbMenu)) return;
  // Read here, not from the mount-time snapshot, which may predate a popup
  // toggle. Shared read (ui/settings-cache.ts): a popup change drops the slot,
  // so this is as current as a raw storage round trip, without a third one per pick.
  const settings = await readContentSettings();
  if (!settings.autoTriggerNative) return;

  const recorded = await getAutoNative(point.target, userId);
  const decision = decideNativeTrigger({
    reaction,
    sentiment: reaction === null ? "neutral" : resolveSentiment(reaction, settings.emojiSentiment),
    fbMatch: reaction === null || !fbMenu ? null : resolveFbReaction(reaction),
    hasLike: !!nv.like,
    hasDislike: !!nv.dislike,
    hasFbMenu: !!fbMenu,
    likePressed: readPressed(nv.like, nv.likePressed),
    dislikePressed: readPressed(nv.dislike),
    recorded,
  });

  switch (decision.kind) {
    case "none":
      return;
    case "press-like": {
      if (!nv.like?.isConnected) return;
      deps.press(nv.like);
      await setAutoNative(point.target, "like", userId);
      return;
    }
    case "press-dislike": {
      if (!nv.dislike?.isConnected) return;
      deps.press(nv.dislike);
      await setAutoNative(point.target, "dislike", userId);
      return;
    }
    case "unpress": {
      await undoRecordedPress(nv, decision.recorded, deps);
      await setAutoNative(point.target, null, userId);
      return;
    }
    case "fb-reaction": {
      if (!fbMenu) return;
      const picked = await deps.pickFb(fbMenu, decision.fb.index);
      if (picked) {
        await setAutoNative(point.target, `fb:${decision.fb.name}`, userId);
        return;
      }
      // Flyout failed. Only the Like entry has a plain-click equivalent; a
      // press is safe solely when the control provably reads unpressed.
      if (decision.fb.index === 0 && nv.like?.isConnected && readPressed(nv.like, nv.likePressed) === false) {
        deps.press(nv.like);
        await setAutoNative(point.target, "like", userId);
      }
      return;
    }
  }
}

// Undo our recorded press. Clicking a control that is no longer pressed would
// PRESS it (the FB incident: "clear" on an unpressed Like set a like), so only
// a control still reading pressed (or unknown-but-recorded) gets the click.
async function undoRecordedPress(nv: NativeVoteActions, recorded: NativeAutoAction, deps: NativeTriggerDeps): Promise<void> {
  if (recorded === "like" || recorded.startsWith("fb:")) {
    const el = nv.like;
    if (!el?.isConnected) return; // nothing to undo against; the record is cleared either way
    if (readPressed(el, nv.likePressed) === false) return; // user already undid it
    deps.press(el);
    return;
  }
  if (recorded === "dislike") {
    const el = nv.dislike;
    if (!el?.isConnected) return;
    if (readPressed(el) === false) return;
    deps.press(el);
  }
}
