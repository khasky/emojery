// SPDX-License-Identifier: GPL-3.0-or-later
//
// "Do it once the tab is on screen." The surfaces that owe the user that wait -
// the coach-mark's one-shot claim, the picker's post-sign-in cast, and the
// onboarding checklist's arming and its confetti - were each spelling the same
// listener dance out for themselves.
//
// Tab visibility is all this answers. The visible tab of an unfocused window
// counts here; the stricter question - is a trigger in front of a person right
// now - is ui/trigger-seen.ts, which adds window focus and an IntersectionObserver.

/**
 * Run `run` at once when the tab is visible, otherwise at the first moment it is.
 * Fires at most once. The returned canceller drops a wait that has not fired yet;
 * calling it afterwards does nothing.
 */
export function onceVisible(run: () => void): () => void {
  if (document.visibilityState === "visible") {
    run();
    return () => {};
  }
  const onChange = (): void => {
    if (document.visibilityState !== "visible") return;
    document.removeEventListener("visibilitychange", onChange);
    run();
  };
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * The awaitable form, for a caller already inside an async flow. A promise carries
 * no canceller, so this wait can outlive whatever asked for it - the caller
 * re-checks its own preconditions after the await.
 */
export function whenVisible(): Promise<void> {
  return new Promise<void>((resolve) => {
    onceVisible(resolve);
  });
}
