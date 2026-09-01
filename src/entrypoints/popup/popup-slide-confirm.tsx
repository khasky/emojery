// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef, useState } from "preact/hooks";
import { useAutoFocus } from "./popup-shared";

// Stroke `currentColor` so the thumb's text colour drives the slide icons.
const slideIcon = (d: string) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
    <path d={d} />
  </svg>
);

// Geometry shared by the JS pointer maths and the inline CSS calc() so the
// thumb lands flush against each track edge. PAD is the gap inside the track,
// THUMB the diameter, EDGE the total horizontal space the thumb can't enter.
const SLIDE_PAD = 3;
const SLIDE_THUMB = 32;
const SLIDE_EDGE = SLIDE_THUMB + SLIDE_PAD * 2;
// Released past this fraction of travel = confirmed; below it springs back.
const SLIDE_THRESHOLD = 0.9;
// Non-drag interaction tuning: one track click's advance, one Arrow-key step, how long
// an idle partial advance survives, and the window after a drag in which the click the
// browser synthesizes from it is ignored.
const SLIDE_CLICK_STEP = 0.25;
const SLIDE_KEY_STEP = 0.1;
const SLIDE_STEP_RESET_MS = 3000;
// Faster than the drag itself, so the "slide to confirm" prompt is gone before the thumb
// reaches the end rather than sitting under it.
const LABEL_FADE_RATE = 1.6;
const SLIDE_POST_DRAG_CLICK_MS = 250;

// Slide-to-confirm: the deliberate drag replaces a confirm() dialog for a destructive action - a stray tap
// can't fire it, releasing early springs the thumb back, and `onConfirm` fires exactly once when the thumb lands.
// Exposed as an ARIA slider (Arrow/End keys work). Dragging is never the only pointer path
// (WCAG 2.5.7): clicking the track advances the thumb a step at a time, with an auto-reset, so
// single-tap AT (voice/head pointer) can confirm while a lone stray tap still can't.
export const SlideToConfirm = ({ label, autoFocus, onConfirm }: { label: string; autoFocus?: boolean; onConfirm: () => void }) => {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const progressRef = useRef(0);
  const draggingRef = useRef(false);
  const lastDragEndRef = useRef(0);
  const stepResetTimer = useRef<number | null>(null);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [done, setDone] = useState(false);

  // The arming button unmounts when this control appears, so the thumb takes focus.
  useAutoFocus(thumbRef, autoFocus);

  useEffect(
    () => () => {
      if (stepResetTimer.current !== null) clearTimeout(stepResetTimer.current);
    },
    [],
  );

  const setSlideProgress = (next: number) => {
    const clamped = next < 0 ? 0 : next > 1 ? 1 : next;
    progressRef.current = clamped;
    setProgress(clamped);
  };

  const confirm = () => {
    // A pending step-reset must not spring the thumb back after landing.
    if (stepResetTimer.current !== null) {
      clearTimeout(stepResetTimer.current);
      stepResetTimer.current = null;
    }
    setSlideProgress(1);
    setDone(true);
    onConfirm();
  };

  const trackTo = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const travel = Math.max(1, rect.width - SLIDE_EDGE);
    setSlideProgress((clientX - rect.left - SLIDE_PAD - SLIDE_THUMB / 2) / travel);
  };

  const onPointerDown = (e: Event) => {
    if (done) return;
    const pe = e as PointerEvent;
    draggingRef.current = true;
    setDragging(true);
    try {
      (pe.currentTarget as HTMLElement).setPointerCapture(pe.pointerId);
    } catch {
      // setPointerCapture is absent in some embedded webviews; drag still
      // works via the element's own move events, just without capture.
    }
    trackTo(pe.clientX);
  };
  const onPointerMove = (e: Event) => {
    if (!draggingRef.current) return;
    trackTo((e as PointerEvent).clientX);
  };
  const onPointerEnd = () => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    lastDragEndRef.current = Date.now();
    setDragging(false);
    if (progressRef.current >= SLIDE_THRESHOLD) confirm();
    else setSlideProgress(0);
  };

  // Non-drag pointer path: each track click advances the thumb a quarter of the
  // travel; inactivity springs it back, so the confirm still takes deliberate,
  // repeated input. Clicks on the thumb (or synthesized after a drag) are ignored.
  const onTrackClick = (e: Event) => {
    if (done) return;
    const thumb = thumbRef.current;
    if (thumb && (e.target === thumb || thumb.contains(e.target as Node))) return;
    if (Date.now() - lastDragEndRef.current < SLIDE_POST_DRAG_CLICK_MS) return;
    if (stepResetTimer.current !== null) clearTimeout(stepResetTimer.current);
    const next = progressRef.current + SLIDE_CLICK_STEP;
    if (next >= SLIDE_THRESHOLD) {
      confirm();
      return;
    }
    setSlideProgress(next);
    stepResetTimer.current = window.setTimeout(() => {
      if (!draggingRef.current && !done) setSlideProgress(0);
    }, SLIDE_STEP_RESET_MS);
  };

  const onKeyDown = (e: Event) => {
    if (done) return;
    let next = progressRef.current;
    switch ((e as KeyboardEvent).key) {
      case "ArrowRight":
      case "ArrowUp":
        next += SLIDE_KEY_STEP;
        break;
      case "ArrowLeft":
      case "ArrowDown":
        next -= SLIDE_KEY_STEP;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 1;
        break;
      default:
        return;
    }
    e.preventDefault();
    if (next >= SLIDE_THRESHOLD) confirm();
    else setSlideProgress(next);
  };

  const travel = `${progress} * (100% - ${SLIDE_EDGE}px)`;

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: the track is decorative; the interactive control is the role="slider" thumb below
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path lives on the thumb (onKeyDown, Arrow/Home/End) - a second handler here would double every keystroke
    <div ref={trackRef} class={`slide-confirm${dragging ? " dragging" : ""}${done ? " done" : ""}`} onClick={onTrackClick}>
      {/* Left edge is pinned at SLIDE_PAD in CSS; width reaches the thumb's
          right edge so the thumb always caps the fill. */}
      <div class="slide-confirm-fill" style={`width:calc(${SLIDE_THUMB}px + ${travel})`} />
      <span class="slide-confirm-label" style={`opacity:${Math.max(0, 1 - progress * LABEL_FADE_RATE)}`}>
        {label}
      </span>
      <div
        ref={thumbRef}
        class="slide-confirm-thumb"
        style={`left:calc(${SLIDE_PAD}px + ${travel})`}
        role="slider"
        tabIndex={done ? -1 : 0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        aria-valuetext={`${Math.round(progress * 100)}%`}
        aria-disabled={done ? "true" : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onKeyDown={onKeyDown}
      >
        {done ? slideIcon("M5 13l4 4 10-10") : slideIcon("M9 6l6 6-6 6")}
      </div>
    </div>
  );
};
