// SPDX-License-Identifier: GPL-3.0-or-later
//
// The generic pressed-state read for "Auto-press original buttons", kept in a module
// of its own because it has to stay reachable from two places that share nothing else:
// ui/native-trigger.ts, which runs it on the page, and e2e/site-auth, which serializes
// it into a live site to check it against that site's real controls. A DOM-only module
// with no extension-runtime imports is what lets the second one hold.

// Adapter override first, then the locale-free signals (aria-pressed, X's data-testid,
// GitHub's star/unstar form action). Null means nothing readable answered.
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
