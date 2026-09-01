// SPDX-License-Identifier: GPL-3.0-or-later
//
// Presentational pieces of the picker, kept out of picker.tsx so that file
// holds the state machine and layout composition rather than every button's
// markup. Each part here takes plain data plus callbacks.
import type { ComponentChild, ComponentChildren, Ref } from "preact";
import { COUNTER_CLASS, RING_CLASS, TRIGGER_CLASS } from "../shared/dom";
import { getEmojiLabel } from "../shared/emoji-meta";
import { t } from "../shared/i18n";
import type { Reaction } from "../shared/reactions";
import { CATEGORIES } from "../shared/reactions";
import { EmojiImg } from "./emoji-img";
import { formatCount } from "./picker-counts";

// tabIndex -1: the grid is one roving Tab stop, not one per emoji (useGridRovingFocus promotes
// exactly one item to tabIndex 0; Arrow keys do the rest).
export const EmojiButton = ({ emoji, selected, onPick, onKeyDown }: { emoji: string; selected: boolean; onPick: (emoji: Reaction, ev?: MouseEvent) => void; onKeyDown: (e: KeyboardEvent) => void }) => {
  const label = getEmojiLabel(emoji);
  return (
    <button class="khasky-emojery-grid-item" type="button" tabIndex={-1} aria-pressed={selected} data-selected={selected} title={label} aria-label={label} onClick={(ev: MouseEvent) => onPick(emoji, ev)} onKeyDown={onKeyDown}>
      <EmojiImg emoji={emoji} />
    </button>
  );
};

// One titled block of the emoji grid (Recently used, Popular, or a category).
//
// A labelled `role="group"`, not a bare <section>: an unnamed <section> carries no role at all,
// so a screen reader read the whole palette as one flat run with no idea which block it was in.
// `role="group"` + aria-labelledby names each block without making it a landmark (a NAMED
// <section> would - nine categories, nine landmarks).
//
// The buttons stay <button aria-pressed> rather than becoming a role="grid"/"gridcell" tree:
// the visual grid is a flat CSS `repeat(6, 1fr)` with no per-row element the grid role
// requires. Arrow-key movement is a roving tabindex over the buttons (see useGridRovingFocus).
export const EmojiSection = ({
  headingId,
  heading,
  action,
  categoryIndex,
  children,
}: {
  headingId: string;
  heading: string;
  action?: ComponentChild;
  // Index into CATEGORIES, read by the popover's scroll-spy to colour the nav icons.
  categoryIndex?: number;
  children: ComponentChildren;
}) => (
  // biome-ignore lint/a11y/useSemanticElements: a fieldset would drag form semantics/styling into the shadow-DOM picker; role="group" on a section is intentional (and keeps it off the landmark list)
  <section role="group" aria-labelledby={headingId} {...(categoryIndex === undefined ? {} : { "data-khasky-emojery-cat": categoryIndex })}>
    <div class={`khasky-emojery-section-h${action ? " khasky-emojery-section-h--row" : ""}`} id={headingId}>
      {action ? <span>{heading}</span> : heading}
      {action}
    </div>
    <div class="khasky-emojery-grid">{children}</div>
  </section>
);

// Single merged trigger: counter style when reactions exist, a compact emoji-icon button
// when not; the user's own reaction is emphasised in the counter trio via the data attr.
export const PickerTrigger = ({
  triggerRef,
  mine,
  total,
  topReactions,
  open,
  onPointer,
  onClick,
  onKeyDown,
}: {
  triggerRef: Ref<HTMLButtonElement>;
  mine: Reaction | null;
  total: number;
  topReactions: Reaction[];
  open: boolean;
  onPointer: (e: MouseEvent | PointerEvent) => void;
  onClick: (e: MouseEvent) => void;
  onKeyDown: (e: KeyboardEvent) => void;
}) => {
  const shared = {
    ref: triggerRef,
    type: "button" as const,
    "data-active": mine !== null,
    onPointerDown: onPointer,
    onMouseDown: onPointer,
    onClick,
    onKeyDown,
    "aria-haspopup": "dialog" as const,
    "aria-expanded": open,
  };
  if (total > 0) {
    return (
      <button {...shared} class={COUNTER_CLASS} aria-label={t("pickerReactionsAria", String(total))}>
        <span class="khasky-emojery-counter-emojis" aria-hidden="true">
          {topReactions.map((r) => (
            <span key={r} data-mine={mine === r}>
              <EmojiImg emoji={r} />
            </span>
          ))}
          <GradientRing />
        </span>
        <span class="khasky-emojery-counter-total" aria-live="polite">
          {formatCount(total)}
        </span>
        <GradientRing />
      </button>
    );
  }
  return (
    <button {...shared} class={TRIGGER_CLASS} aria-label={mine ? t("pickerYourReaction", getEmojiLabel(mine)) : t("pickerAddReaction")}>
      <span class="khasky-emojery-trigger-icon" aria-hidden="true">
        <EmojiImg emoji={mine ?? "🙂"} />
        <GradientRing />
      </span>
      <GradientRing />
    </button>
  );
};

// Decorative gradient border (picker.css `.khasky-emojery-ring`). Rendered on both the
// button and its icon; CSS shows whichever one the current trigger form uses. An element
// rather than a pseudo-element so the spin can rotate a layer inside the static mask, which
// keeps the animation on the compositor. Always LAST in its parent: the counter's emoji
// stack is styled through `> span:first-child` / `> span:nth-child(n + 2)`, which a leading
// child would shift.
const GradientRing = () => <i class={RING_CLASS} aria-hidden="true" />;

// Per-reaction totals above the grid, so users land on existing social signal
// before the act of contributing. Paginated by the caller (see BREAKDOWN_INITIAL).
export const ReactionBreakdown = ({ entries, mine, showToggle, expanded, onToggle, onPick }: { entries: [string, number | undefined][]; mine: Reaction | null; showToggle: boolean; expanded: boolean; onToggle: () => void; onPick: (emoji: Reaction, ev?: MouseEvent) => void }) => (
  <div class="khasky-emojery-breakdown-list">
    {entries.map(([r, n]) => {
      const label = getEmojiLabel(r);
      return (
        // The label includes the visible count - an aria-label alone would hide
        // the per-reaction totals from screen readers entirely.
        <button class="khasky-emojery-breakdown-row" key={r} type="button" data-selected={mine === r} aria-label={`${t("pickerReactWith", label)}, ${formatCount(n ?? 0)}`} onClick={(ev: MouseEvent) => onPick(r, ev)}>
          <span aria-hidden="true">
            <EmojiImg emoji={r} />
          </span>
          <span class="khasky-emojery-breakdown-label" title={label}>
            {label}
          </span>
          <span class="khasky-emojery-breakdown-count">{formatCount(n ?? 0)}</span>
        </button>
      );
    })}
    {showToggle && (
      <button class="khasky-emojery-breakdown-more" type="button" onClick={onToggle}>
        {expanded ? t("pickerShowLess") : t("pickerShowMore")}
      </button>
    )}
  </div>
);

// Category shortcuts under the search box: each icon stays grayscale until its section
// scrolls into view, then fades to colour in step with the scroll (`intensity` comes
// from the picker's scroll-spy); an accent underline fades in on the same signal.
export const CategoryBar = ({ intensity, onSelect }: { intensity: number[]; onSelect: (index: number) => void }) => (
  // biome-ignore lint/a11y/useSemanticElements: a fieldset would drag form semantics/styling into the shadow-DOM picker; role="group" on a div is intentional
  <div class="khasky-emojery-cat-bar" role="group" aria-label={t("pickerCategoriesAria")}>
    {CATEGORIES.map((cat, i) => {
      const on = intensity[i] ?? 0;
      const label = t(cat.nameKey);
      return (
        <button key={cat.nameKey} type="button" class="khasky-emojery-cat-btn" title={label} aria-label={label} onClick={() => onSelect(i)} style={{ filter: `grayscale(${1 - on})` }}>
          <span class="khasky-emojery-cat-icon" aria-hidden="true">
            <EmojiImg emoji={cat.icon} />
          </span>
          <span class="khasky-emojery-cat-underline" aria-hidden="true" style={{ opacity: on }} />
        </button>
      );
    })}
  </div>
);
