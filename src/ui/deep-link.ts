// SPDX-License-Identifier: GPL-3.0-or-later
//
// One-shot /react deep-link arming for the content script. On page load we read
// the `#emojery-react[=<key>]` hint (see shared/deep-link.ts), remember it, and strip our
// hash from the URL so it neither lingers in the address bar nor re-fires on SPA
// navigation. renderPicker consumes it: the matching target (or the first, for the
// keyless form) auto-opens its picker exactly once.
//
// Deliberate: ANY inbound link can carry the hint (a referrer check would be
// spoofable anyway), so a third-party link may open the picker uninvited. The
// blast radius is bounded by design - opening is all it does; a vote still
// needs a real user click inside the picker, and a reaction is reversible.

import { parseReactHint, type ReactHint } from "../shared/deep-link";
import type { TargetKey } from "../shared/storage";

let pending: ReactHint | null = null;

export function armReactHint(): void {
  if (typeof location === "undefined") return;
  const hint = parseReactHint(location.hash);
  if (!hint) return;
  pending = hint;
  try {
    history.replaceState(history.state, "", location.pathname + location.search);
  } catch {} // best-effort: the hint is already remembered; a failure only leaves the hash
}

// A keyed hint matches only its own `site:targetId`; a keyless one matches the first target to ask.
export function consumeReactHint(key: TargetKey): boolean {
  if (!pending) return false;
  if (pending.targetKey !== null && pending.targetKey !== key) return false;
  pending = null;
  return true;
}

export function __resetReactHintForTest(): void {
  pending = null;
}
