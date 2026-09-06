// SPDX-License-Identifier: GPL-3.0-or-later
//
// Keep re-blending a mounted host until its action row stops moving.
//
// doMount stamps a complete look from what the row measures AT MOUNT; this is the
// refinement pass for rows that are not finished being built then - a late-hydrating
// count, a button that gets its real radius a tick after its label, an icon that
// arrives seconds after the row does. Its own module rather than a tail on mount.ts:
// the schedule is a timing policy with four collaborators of its own (style re-apply,
// the registry that owns the timers, the viewport margin, the native counts), and
// mount.ts is the coordinator that should delegate it, not host it.
import type { PickerInsertionPoint } from "../shared/adapter";
import { isNearPrefetchMargin } from "./mount-anchors";
import { trackHostTimer } from "./mount-registry";
import { applyHostRowHeight, hostShapeSignature, reapplyHostShape, revealHost } from "./mount-style";
import { compactNativeCountsOnOverflow } from "./native-compact";

// Absolute ms from mount: sites hydrate their action rows at very different times
// (Reddit a beat late, YouTube's watch row past two seconds), so the schedule spreads.
const STYLE_REBLEND_DELAYS_MS = [150, 500, 1200, 2400];
// Consecutive passes that must change nothing before the schedule stops early. Two, not
// one: a row can measure its glyph a tick before its buttons get their real radius, and
// a single quiet pass would call that settled and strand the first look.
const STYLE_REBLEND_SETTLED_PASSES = 2;
// A host held hidden for its first glyph measure (SIZING_ATTR) is force-revealed here even
// if the icon never became measurable - em-fallback sizing beats an invisible button.
const SIZING_REVEAL_DEADLINE_MS = 1200;
// Re-measure past the delays above while the trigger still wears a stand-in size (see
// applyHostRowHeight): one measurement per tick, only for a host that never read its row's own
// icon - a settled one stops after the first tick.
const GLYPH_REMEASURE_EVERY_MS = 800;
const GLYPH_REMEASURE_UNTIL_MS = 10_000;

export function scheduleStyleReblend(host: HTMLElement, point: PickerInsertionPoint): void {
  // Tracked per host so removeMountNode cancels them: a feed that mounts and
  // recycles 30 cards used to keep 150 live timers, each forcing layout on an
  // already-detached (or soon-detached) host.
  scheduleReblendStep(host, point, 0, hostShapeSignature(host), 0);
  trackHostTimer(
    host,
    window.setTimeout(() => {
      if (host.isConnected) revealHost(host);
    }, SIZING_REVEAL_DEADLINE_MS),
  );
  remeasureGlyphUntilFinal(host, point, Date.now() + GLYPH_REMEASURE_UNTIL_MS);
}

// One tick armed at a time rather than the whole schedule up front: what it bounds is the work
// PER TRIGGER, which is what a feed multiplies - a row already settled at mount stops after the
// second pass instead of re-reading the surrounding controls four times. e2e/perf.spec.ts holds
// the budget that keeps it from growing.
function scheduleReblendStep(host: HTMLElement, point: PickerInsertionPoint, index: number, lastSignature: string, quietPasses: number): void {
  const at = STYLE_REBLEND_DELAYS_MS[index];
  if (at === undefined) return;
  trackHostTimer(
    host,
    window.setTimeout(
      () => {
        if (!host.isConnected) return;
        // A card the user has already scrolled past keeps whatever doMount stamped -
        // a complete blend, this schedule only refines it - so there is nothing to
        // show for re-reading its row. Not counted as a quiet pass: scrolling back
        // inside the window resumes the schedule where it left off.
        if (!isNearPrefetchMargin(host)) {
          scheduleReblendStep(host, point, index + 1, lastSignature, quietPasses);
          return;
        }
        const glyphFinal = reapplyHostShape(host, point);
        // Counts hydrate late on some sites - the row can start fitting and
        // overflow only once the full number renders, so re-check here too.
        compactNativeCountsOnOverflow(host, point);
        const signature = hostShapeSignature(host);
        const quiet = signature === lastSignature ? quietPasses + 1 : 0;
        // A stand-in glyph is never settled, however quiet the pass was: the row that
        // hydrates its icon past this schedule is exactly the one the later ticks exist for.
        if (glyphFinal && quiet >= STYLE_REBLEND_SETTLED_PASSES) return;
        scheduleReblendStep(host, point, index + 1, signature, quiet);
      },
      at - (STYLE_REBLEND_DELAYS_MS[index - 1] ?? 0),
    ),
  );
}

// Self-rescheduling rather than an interval, so the chain simply stops on the tick that
// reads the row's own icon (or when the host goes away / the window closes).
function remeasureGlyphUntilFinal(host: HTMLElement, point: PickerInsertionPoint, deadline: number): void {
  trackHostTimer(
    host,
    window.setTimeout(() => {
      if (!host.isConnected || applyHostRowHeight(host, point) || Date.now() >= deadline) return;
      remeasureGlyphUntilFinal(host, point, deadline);
    }, GLYPH_REMEASURE_EVERY_MS),
  );
}
