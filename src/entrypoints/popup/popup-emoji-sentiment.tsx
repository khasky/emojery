// SPDX-License-Identifier: GPL-3.0-or-later
//
// The "Auto-press native buttons" list editor: three zones (presses Like /
// presses Dislike / presses nothing) the user rearranges by dragging an emoji
// between them, with a click-to-move fallback (select an emoji, then a zone)
// for keyboard and touch. Neutral is implicit - everything not assigned - so
// only the positive/negative lists persist (see Settings.emojiSentiment).
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { getEmojiLabel, onLocalesChanged, searchEmojis } from "../../shared/emoji-meta";
import { t } from "../../shared/i18n";
import { DEFAULT_EMOJI_SENTIMENT, type Sentiment } from "../../shared/native-actions";
import { REACTIONS } from "../../shared/reactions";
import type { Settings } from "../../shared/storage";
import { EmojiImg } from "../../ui/emoji-img";
import { SearchField } from "./popup-shared";

// First page of the neutral grid.
const NEUTRAL_PAGE = 64;
// Each "Show more" adds four more pages.
const NEUTRAL_SHOW_MORE_STEP = NEUTRAL_PAGE * 4;

export const EmojiSentimentEditor = ({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => Promise<void> }) => {
  const { positive, negative } = settings.emojiSentiment;
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(NEUTRAL_PAGE);
  // Click-to-move selection (a11y/touch fallback for drag-and-drop).
  const [selected, setSelected] = useState<string | null>(null);
  // Emoji labels/search data loads lazily (English included); re-render when a
  // locale map lands so aria-labels and an in-flight search pick it up.
  const [localeGen, setLocaleGen] = useState(0);
  useEffect(() => onLocalesChanged(() => setLocaleGen((n) => n + 1)), []);

  const assigned = useMemo(() => new Set([...positive, ...negative]), [positive, negative]);
  const neutralAll = useMemo(() => REACTIONS.filter((e) => !assigned.has(e)), [assigned]);
  const trimmedQuery = query.trim();
  // `localeGen` is a real input: searchEmojis reads the module-level locale maps, so a map
  // landing mid-query has to re-run the match, not replay the memoized one.
  const neutralMatches = useMemo(() => (trimmedQuery ? searchEmojis(trimmedQuery, neutralAll) : neutralAll), [trimmedQuery, neutralAll, localeGen]);
  const neutralVisible = neutralMatches.slice(0, shown);

  const moveTo = (emoji: string, dest: Sentiment) => {
    const next = {
      positive: positive.filter((e) => e !== emoji),
      negative: negative.filter((e) => e !== emoji),
    };
    if (dest === "positive") next.positive.push(emoji);
    else if (dest === "negative") next.negative.push(emoji);
    setSelected(null);
    void update({ emojiSentiment: next });
  };

  const chip = (emoji: string) => (
    <button
      key={emoji}
      type="button"
      class={selected === emoji ? "sentiment-chip sentiment-chip-selected" : "sentiment-chip"}
      draggable
      aria-label={getEmojiLabel(emoji)}
      aria-pressed={selected === emoji ? "true" : "false"}
      onDragStart={(e: DragEvent) => {
        if (e.dataTransfer) {
          e.dataTransfer.setData("text/plain", emoji);
          // Default ghost snapshots a whole ancestor block (the chip's sprite
          // <img> is the full sheet, only CSS-cropped) - draw the one glyph
          // on a small canvas instead.
          const ghost = document.createElement("canvas");
          ghost.width = 32;
          ghost.height = 32;
          const ctx = ghost.getContext("2d");
          if (ctx) {
            ctx.font = "26px serif";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            ctx.fillText(emoji, 16, 18);
            e.dataTransfer.setDragImage(ghost, 16, 16);
          }
        }
        setSelected(null);
      }}
      onClick={() => setSelected(selected === emoji ? null : emoji)}
    >
      <EmojiImg emoji={emoji} />
    </button>
  );

  const zone = (dest: Sentiment, label: string, children: ComponentChildren) => (
    // biome-ignore lint/a11y/noStaticElementInteractions: the drop zone is a pointer convenience; the zone's own <button> title is the real control
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard users move an emoji via the zone-title button (Tab + Enter), so a handler here would fire the move twice
    <section
      class={selected ? "sentiment-zone sentiment-zone-droppable" : "sentiment-zone"}
      data-zone={dest}
      onDragOver={(e: DragEvent) => e.preventDefault()}
      onDrop={(e: DragEvent) => {
        e.preventDefault();
        const emoji = e.dataTransfer?.getData("text/plain");
        if (emoji && REACTIONS.includes(emoji)) moveTo(emoji, dest);
      }}
      // Click-to-move accepts a tap ANYWHERE in the zone (matching the intro
      // copy), not just the title - except on interactive children, whose
      // clicks mean themselves (chip = change selection, search, show-more).
      onClick={(e: Event) => {
        if (!selected) return;
        const target = e.target as HTMLElement;
        if (target.closest(".sentiment-chip, .settings-filter, .sentiment-show-more")) return;
        moveTo(selected, dest);
      }}
    >
      <button
        type="button"
        class="sentiment-zone-title"
        disabled={!selected}
        // Keyboard path (Tab + Enter); stopPropagation so the zone's own
        // click handler doesn't double the move.
        onClick={(e: Event) => {
          e.stopPropagation();
          if (selected) moveTo(selected, dest);
        }}
      >
        {label}
      </button>
      <div class="sentiment-grid">{children}</div>
    </section>
  );

  return (
    <div class="sentiment-editor">
      <p class="sentiment-intro">{t("sentimentIntro")}</p>
      {zone("positive", t("sentimentPositiveZone"), positive.map(chip))}
      {zone("negative", t("sentimentNegativeZone"), negative.map(chip))}
      {zone(
        "neutral",
        t("sentimentNeutralZone"),
        <div class="sentiment-neutral">
          <SearchField
            wrapClass="settings-filter"
            inputClass="settings-filter-input"
            placeholder={t("pickerSearchPlaceholder")}
            ariaLabel={t("pickerSearchAriaLabel")}
            value={query}
            onInput={(next: string) => {
              setQuery(next);
              setShown(NEUTRAL_PAGE);
            }}
          />
          <div class="sentiment-grid">{neutralVisible.map(chip)}</div>
          {neutralMatches.length > shown ? (
            <button type="button" class="sentiment-show-more" onClick={() => setShown(shown + NEUTRAL_SHOW_MORE_STEP)}>
              {t("pickerShowMore")}
            </button>
          ) : null}
        </div>,
      )}
      <button
        type="button"
        class="sentiment-reset"
        onClick={() =>
          void update({
            emojiSentiment: {
              positive: [...DEFAULT_EMOJI_SENTIMENT.positive],
              negative: [...DEFAULT_EMOJI_SENTIMENT.negative],
            },
          })
        }
      >
        {t("sentimentReset")}
      </button>
    </div>
  );
};
