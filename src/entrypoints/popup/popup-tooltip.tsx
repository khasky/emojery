// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChild } from "preact";
import { useEffect, useId, useRef, useState } from "preact/hooks";
import { safeHttpHref } from "../../shared/safe-href";

// A trigger whose bottom sits past this fraction of the viewport opens its tooltip
// UPWARD, so a tall tooltip on a low row stays on-screen. Slightly past the midpoint:
// just below it there is still more room under the trigger than the tooltip needs, so
// the flip waits until the trigger's bottom passes this line.
const TOOLTIP_FLIP_VIEWPORT_FRACTION = 0.55;
// Gap between the trigger and the tooltip - small enough that the pointer crosses it
// within the grace delay below.
const TOOLTIP_TRIGGER_GAP_PX = 6;
// Grace delay so the pointer can cross that gap without the tooltip vanishing -
// hoverable per WCAG 1.4.13.
const TOOLTIP_HIDE_GRACE_MS = 150;
// `window.innerHeight` is 0 in no-layout environments (the popup's own default height
// is 480px); only the flip side of an unmeasurable viewport rides on this.
const FALLBACK_VIEWPORT_HEIGHT_PX = 480;

// Floating tooltip anchored to its trigger. `position: fixed` (computed from the trigger's viewport rect)
// escapes the tab-panel's `overflow: auto` clipping without a portal - the panel establishes no containing
// block for fixed descendants. `content` is a THUNK, not a node: a history page renders 100 rows and only
// the hovered one ever shows its tooltip, so building each row's content eagerly (renderUrlParts parses
// the whole URL) was work thrown away on every re-render.
type TooltipProps =
  | {
      variant: "link";
      href: string;
      wrapClass: string;
      trigger: ComponentChild;
      content: () => ComponentChild;
    }
  | {
      variant: "text";
      wrapClass: string;
      trigger: ComponentChild;
      content: () => ComponentChild;
    };

// At most one tooltip is open at a time: the popup spans the panel width, so a stale one left to the grace
// timer overlaps the next row and swallows the pointer over it. The slot holds a per-instance REF, not the
// hide function: `hideNow` is a fresh closure every render, so a function identity could never be matched
// back on release.
type TooltipHandle = { current: () => void };

let soleOpenTooltip: TooltipHandle | null = null;

function claimSoleTooltip(handle: TooltipHandle): void {
  if (soleOpenTooltip && soleOpenTooltip !== handle) soleOpenTooltip.current();
  soleOpenTooltip = handle;
}

function releaseSoleTooltip(handle: TooltipHandle): void {
  if (soleOpenTooltip === handle) soleOpenTooltip = null;
}

export const HoverTooltip = (props: TooltipProps) => {
  const ref = useRef<HTMLElement | null>(null);
  const hideTimer = useRef<number | null>(null);
  // This instance's identity in the single-open slot above. Re-pointed at each
  // render's `hideNow` so the slot always calls the current closure.
  const selfHide = useRef<() => void>(() => {});
  const [tip, setTip] = useState<{ above: boolean; offset: number } | null>(null);
  // Stable id so the trigger can reference the open tooltip via aria-describedby -
  // without it screen readers never surface the tooltip content (WCAG 1.3.1).
  const tipId = useId();

  const cancelHide = () => {
    if (hideTimer.current !== null) {
      clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
  };
  const hideNow = () => {
    cancelHide();
    releaseSoleTooltip(selfHide);
    setTip(null);
  };
  selfHide.current = hideNow;
  useEffect(() => hideNow, []);

  const show = () => {
    cancelHide();
    const trigger = ref.current;
    // Nothing to anchor to: leave the currently open tooltip alone rather than
    // closing it for an open that cannot happen.
    if (!trigger) return;
    claimSoleTooltip(selfHide);
    const triggerRect = trigger.getBoundingClientRect();
    const viewportHeight = window.innerHeight || FALLBACK_VIEWPORT_HEIGHT_PX;
    const above = triggerRect.bottom > viewportHeight * TOOLTIP_FLIP_VIEWPORT_FRACTION;
    setTip({
      above,
      offset: above ? Math.round(viewportHeight - triggerRect.top + TOOLTIP_TRIGGER_GAP_PX) : Math.round(triggerRect.bottom + TOOLTIP_TRIGGER_GAP_PX),
    });
  };
  const hide = () => {
    cancelHide();
    hideTimer.current = window.setTimeout(hideNow, TOOLTIP_HIDE_GRACE_MS);
  };
  // Callback ref avoids a per-tag RefObject type clash between the <a> and <span> variants.
  const setRef = (el: HTMLElement | null) => {
    ref.current = el;
  };
  const handlers = {
    ref: setRef,
    onMouseEnter: show,
    onMouseLeave: hide,
    onFocus: show,
    onBlur: hideNow,
    // Dismissible per WCAG 1.4.13: Escape hides the tooltip without moving focus.
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key === "Escape") hideNow();
    },
    "aria-describedby": tip ? tipId : undefined,
  };
  const pop = tip && (
    <span id={tipId} class="tt-pop" role="tooltip" style={tip.above ? `bottom:${tip.offset}px;` : `top:${tip.offset}px;`} onMouseEnter={cancelHide} onMouseLeave={hide}>
      {props.content()}
    </span>
  );

  // Only emit an `<a href>` for an http(s) URL; a non-http scheme (javascript:, data:)
  // renders as inert, focusable text instead - see shared/safe-href.ts.
  const safeHref = props.variant === "link" ? safeHttpHref(props.href) : undefined;
  if (props.variant === "link" && safeHref) {
    return (
      <a {...handlers} class={props.wrapClass} href={safeHref} target="_blank" rel="noopener noreferrer">
        {props.trigger}
        {pop}
      </a>
    );
  }
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: the tooltip opens on focus, so its trigger must be reachable by keyboard (WCAG 1.4.13) even when it is plain text rather than a link
    <span {...handlers} class={props.wrapClass} tabIndex={0}>
      {props.trigger}
      {pop}
    </span>
  );
};

// Render a URL as coloured, labelled segments (protocol/host/path/query/hash) so the tooltip
// reads clearly. Percent-encoded values are decoded; unparseable input falls back to the raw string.
export function renderUrlParts(raw: string): ComponentChild {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return <span class="tt-url">{raw}</span>;
  }
  const safe = (encoded: string): string => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  };
  const parts: ComponentChild[] = [<span class="tt-proto">{`${parsed.protocol}//`}</span>, <span class="tt-host">{parsed.host}</span>];
  // Path segments cycle through the tt-p0..2 palette - see popup.css for why.
  parsed.pathname
    .split("/")
    .filter(Boolean)
    .forEach((seg, i) => {
      parts.push(<span class="tt-sep">/</span>);
      parts.push(<span class={`tt-path tt-p${i % 3}`}>{safe(seg)}</span>);
    });
  [...parsed.searchParams.entries()].forEach(([key, value], i) => {
    parts.push(<span class="tt-sep">{i === 0 ? "?" : "&"}</span>);
    parts.push(<span class="tt-key">{key}</span>);
    if (value !== "") {
      parts.push(<span class="tt-sep">=</span>);
      parts.push(<span class="tt-val">{safe(value)}</span>);
    }
  });
  if (parsed.hash) {
    parts.push(<span class="tt-sep">#</span>);
    parts.push(<span class="tt-path">{safe(parsed.hash.slice(1))}</span>);
  }
  return <span class="tt-url">{parts}</span>;
}
