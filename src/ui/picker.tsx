// SPDX-License-Identifier: GPL-3.0-or-later

import { createPortal } from "preact/compat";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";
import { PAGE_FONT_VAR } from "../shared/dom";
import { ensureLocaleLoaded, onLocalesChanged, searchEmojis } from "../shared/emoji-meta";
import { t } from "../shared/i18n";
import type { VoteBroadcast } from "../shared/messages";
import { getPopularSync, primePopular } from "../shared/popular";
import { applyCountsDelta, applyTotalDelta } from "../shared/reaction-delta";
import type { Reaction, ReactionCounts, TargetCounts } from "../shared/reactions";
import { CATEGORIES, REACTIONS } from "../shared/reactions";
import { clearRecentEmojis, getRecentEmojis } from "../shared/recents";
import type { ReactionAnimationOrigin } from "./animations";
import { EmojiImg } from "./emoji-img";
import { activeUserId } from "./messaging";
import { deriveOwnReactionDisplay } from "./picker-counts";
import { useCategoryScrollSpy, useGridRovingFocus, usePopoverDismiss, usePopoverPosition } from "./picker-hooks";
import { CategoryBar, EmojiButton, EmojiSection, PickerTrigger, ReactionBreakdown } from "./picker-parts";

// 3 rows x 6 columns - the grid (picker.css) is `repeat(6, 1fr)`, so 18 fills it exactly.
// Newest-clicked lands at index 0 (lastUsed-first sort in `shared/recents.ts`); the 19th
// unique pick evicts the bottom-right cell.
const RECENT_LIMIT = 18;
// Breakdown pagination: 3 rows first to keep the popover compact; "Show more"
// expands to a 10-row cap, and the same button toggles back as "Show less".
const BREAKDOWN_INITIAL = 3;
const BREAKDOWN_EXPANDED = 10;
// The trigger shows at most this many emoji - the "counter trio" picker.css
// sizes with --khasky-emojery-trio-scale.
const COUNTER_TRIO_LIMIT = 3;

// Measured height of the sticky head, published to picker.css as the scroll-padding that
// keeps a keyboard-focused emoji out from under it. Read by
// `.khasky-emojery-popover-scroll`, which spells the name out literally; 0 when the head
// has not been measured yet, which costs the WCAG 2.4.11 padding for that render rather
// than breaking the layout.
const HEAD_HEIGHT_VAR = "--khasky-emojery-head-h";

// Category count, published to picker.css so the popover's width floor follows the
// category bar's own 24px-per-target minimum instead of a number copied by hand.
const CATEGORY_COUNT_VAR = "--khasky-emojery-cat-count";

interface Initial {
  value: TargetCounts;
  myReaction: Reaction | null;
  isAuthed: boolean;
}

interface Props {
  initial: Initial;
  typography?: PickerTypography;
  // Returns `true` when the vote was accepted (auth ok, queued); on `false` (unauthed -
  // host opens the auth tab instead) the picker must NOT paint an optimistic "you reacted"
  // state. `reaction === null` means unreact (toggle-off).
  onPick: (reaction: Reaction | null, origin?: ReactionAnimationOrigin) => Promise<boolean> | boolean;
  // Opens the extension's auth tab. Wired by the host so the picker
  // doesn't reach for chrome.runtime directly.
  onSignIn: () => void;
  /** DOM container outside the page's transformed ancestors, so the portalled
   *  popover's `position: fixed` anchors to the real viewport. Pass a FUNCTION for
   *  a long-lived mount: it re-resolves on every render while open, so a
   *  navigation that detached the previous container (FB reels rebuilding <body>)
   *  can't strand it. */
  portalRoot: HTMLElement | (() => HTMLElement);
  bindBroadcast?: (cb: (b: VoteBroadcast) => void) => void;
  /**
   * Pushes fresh counts without remounting. Both `authed` and `value` are optional: an
   * omitted field keeps its current state (sign-out strips "mine", counts stay put).
   */
  bindRefresh?: (cb: (next: { value?: TargetCounts; myReaction: Reaction | null; authed?: boolean }) => void) => void;
  /**
   * /react deep-link: when true, the picker opens itself once on mount, exactly
   * as a trigger click would - the popover, signed in or not. Set by the mount
   * layer for the target the deep-link named.
   */
  autoOpen?: boolean;
  /** Fires when the popover opens/closes; the mount layer prewarms Facebook's
   *  reactions flyout off it while the user is still choosing (see
   *  ui/native-trigger.ts startFbPrewarm). */
  onOpenChange?: (open: boolean) => void;
}

// The reaction the user sees - public counts, running total, which one is theirs - owned as one
// slice: they only ever move together, through exactly two operations, a delta (own pick or
// another tab's broadcast) and a server snapshot (refresh, sign-in/out).
function useReactionState(initial: Initial) {
  const [counts, setCounts] = useState<ReactionCounts>(initial.value.counts);
  const [total, setTotal] = useState<number>(initial.value.total);
  const [mine, setMine] = useState<Reaction | null>(initial.myReaction);

  // Counts and total derive independently, so each goes through its own functional
  // setState - correct even when two deltas land in the same batch.
  const applyDelta = (prev: Reaction | null, next: Reaction | null): void => {
    setCounts((prevCounts) => applyCountsDelta(prevCounts, prev, next));
    setTotal((prevTotal) => applyTotalDelta(prevTotal, prev, next));
    setMine(next);
  };

  const applySnapshot = (value: TargetCounts | undefined, myReaction: Reaction | null): void => {
    if (value) {
      setCounts(value.counts);
      setTotal(value.total);
    }
    setMine(myReaction);
  };

  return { counts, total, mine, applyDelta, applySnapshot };
}

export function Picker({ initial, typography, onPick, onSignIn, portalRoot, bindBroadcast, bindRefresh, autoOpen, onOpenChange }: Props) {
  const { counts, total, mine, applyDelta, applySnapshot } = useReactionState(initial);
  const [authed, setAuthed] = useState<boolean>(initial.isAuthed);
  const [open, setOpen] = useState(false);
  const [breakdownDisplayLimit, setBreakdownDisplayLimit] = useState(BREAKDOWN_INITIAL);
  const [popPos, setPopPos] = useState<{ top: number; left: number } | null>(null);
  // The reaction a signed-out user already chose in the grid. Non-null swaps the popover
  // for the sign-in gate, which shows this emoji; it is cast for real once auth lands.
  const [pendingReaction, setPendingReaction] = useState<Reaction | null>(null);
  // Whether the popover opened above the trigger - drives the mirrored layout (sticky head
  // at the bottom, beside the button). Decided once per open, preserved while searching.
  const [placedAbove, setPlacedAbove] = useState(false);
  const [query, setQuery] = useState("");
  const [recent, setRecent] = useState<string[]>([]);
  // Account the visible Recents belong to, captured with them at open time so
  // "Clear" writes against the same account the list was read for.
  const [recentUserId, setRecentUserId] = useState<string | null>(null);
  // Popular row - seeded synchronously from the in-memory cache (shared/popular.ts,
  // backend-fetched, cached 24h), so it is filled from the first render. Re-read on each open,
  // never mid-open, so a background refresh cannot reshuffle a visible row.
  const [popular, setPopular] = useState<string[]>(() => getPopularSync());
  // Per-category colour intensity (0 = grayscale, 1 = full colour), driven
  // by the scroll position of the popover's grid (see the scroll-spy effect).
  const [categoryColor, setCategoryColor] = useState<number[]>(() => CATEGORIES.map(() => 0));
  // Bumped when locale data finishes loading so labels/search re-render.
  const [localeVersion, setLocaleVersion] = useState(0);
  // Ids are scoped to this picker's shadow root, but the popover portals into the
  // SHARED overlay host - a per-instance prefix keeps two open popovers from
  // pointing aria-labelledby at each other's headings.
  const sectionIdPrefix = useId();
  const autoOpenedRef = useRef(false);
  const gateSignInRef = useRef<HTMLButtonElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stickyHeadRef = useRef<HTMLDivElement | null>(null);
  const placedAboveRef = useRef<boolean | null>(null);
  const queryRef = useRef(query);

  // Live query for the ResizeObserver callback, which must not re-subscribe per keystroke.
  queryRef.current = query;

  useEffect(() => {
    onOpenChange?.(open);
  }, [open]);

  // Warm the Popular-emoji cache once per content script. Idempotent, so
  // calling it from every picker mount is fine.
  useEffect(() => {
    void primePopular();
  }, []);

  // Bump a version when the locale load resolves so labels and search re-render; likewise for
  // script-triggered loads (typing a Japanese character fetches ja.json in the background ->
  // results refresh on the next render).
  useEffect(() => {
    let cancelled = false;
    void ensureLocaleLoaded().then((map) => {
      if (!cancelled && map) setLocaleVersion((v) => v + 1);
    });
    const unsub = onLocalesChanged(() => {
      if (!cancelled) setLocaleVersion((v) => v + 1);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  useEffect(() => {
    bindRefresh?.((next) => {
      applySnapshot(next.value, next.myReaction);
      if (typeof next.authed === "boolean") setAuthed(next.authed);
    });
  }, [bindRefresh]);

  // The ref keeps the /react deep-link's auto-open to one fire even if `authed` flips and
  // re-runs the effect. Signed-out it opens too - onto the palette; the gate arrives only
  // once a reaction is picked.
  useEffect(() => {
    if (!autoOpen || autoOpenedRef.current) return;
    autoOpenedRef.current = true;
    setOpen(true);
  }, [autoOpen]);

  useEffect(() => {
    bindBroadcast?.((b) => {
      applyDelta(b.prevReaction, b.reaction);
    });
  }, [bindBroadcast]);

  useEffect(() => {
    if (!open) return;
    setPopular(getPopularSync());
    // Recents are per-account, and the account is resolved through the background (see
    // ui/messaging.ts activeUserId) so the picker never reads the token-bearing auth record
    // from a hostile page. Re-read per open: the account can change under a long-lived mount.
    void activeUserId().then(async (userId) => {
      setRecentUserId(userId);
      setRecent(userId ? await getRecentEmojis(userId, RECENT_LIMIT) : []);
    });
    setQuery("");
    setBreakdownDisplayLimit(BREAKDOWN_INITIAL);
    // preventScroll so opening doesn't scroll the popover past the breakdown
    // to reveal the (mid-popover) search input.
    queueMicrotask(() => searchRef.current?.focus({ preventScroll: true }));
  }, [open, authed]);

  // The gate's primary action takes focus the same way the search does, so the
  // grid -> gate swap doesn't strand focus on the emoji button that just vanished.
  useEffect(() => {
    if (!pendingReaction) return;
    queueMicrotask(() => gateSignInRef.current?.focus({ preventScroll: true }));
  }, [pendingReaction]);

  // Closing unmounts the popover; if focus was inside it (search, grid), it would
  // silently fall to <body>. Every close path routes here so keyboard focus returns
  // to the trigger instead (outside clicks on focusable page content still win -
  // the browser moves focus after this handler runs).
  const closePopover = () => {
    const pop = popRef.current;
    if (pop) {
      const root = pop.getRootNode();
      const active = root instanceof ShadowRoot ? root.activeElement : document.activeElement;
      if (active && pop.contains(active)) triggerRef.current?.focus();
    }
    setOpen(false);
  };

  usePopoverPosition({ open, triggerRef, popRef, placedAboveRef, queryRef, setPopPos, setPlacedAbove, close: closePopover });

  useEffect(() => {
    if (!open) {
      setPopPos(null);
      placedAboveRef.current = null;
      // A closed gate forgets the pick - reopening starts back at the grid.
      setPendingReaction(null);
    }
  }, [open]);

  // No close-on-sign-out effect here: `authed` flipping just re-renders the popover as
  // the grid or the sign-in gate, so a stale grid can't survive.

  usePopoverDismiss({ open, triggerRef, popRef, close: closePopover });

  useCategoryScrollSpy({ open, query, recentLength: recent.length, total, mine, breakdownDisplayLimit, placedAbove, scrollRef, stickyHeadRef, setCategoryColor });

  // WCAG 2.4.11 (focus not obscured). Arrow keys move focus with a plain `focus()`
  // (picker-hooks.ts useGridRovingFocus), so the browser scrolls the cell to the
  // scrollport EDGE - which is under the opaque sticky head. `scroll-padding` moves that
  // edge past it, and the height comes from the same `offsetHeight` read `scrollToCategory`
  // uses, so a manual jump and a keyboard jump cannot disagree. Re-measured on `query`
  // because the category bar is dropped from the head while searching.
  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    scrollEl.style.setProperty(HEAD_HEIGHT_VAR, `${stickyHeadRef.current?.offsetHeight ?? 0}px`);
  }, [open, placedAbove, query]);

  const scrollToCategory = (index: number) => {
    const scrollEl = scrollRef.current;
    if (!scrollEl) return;
    const sec = scrollEl.querySelector<HTMLElement>(`[data-khasky-emojery-cat="${index}"]`);
    if (!sec) return;
    // Offset by the sticky head only when it pins the top; when it sits at the
    // bottom (popover above the trigger) the container top is unobstructed.
    const headH = placedAbove ? 0 : (stickyHeadRef.current?.offsetHeight ?? 0);
    const delta = sec.getBoundingClientRect().top - scrollEl.getBoundingClientRect().top - headH;
    scrollEl.scrollTo({ top: scrollEl.scrollTop + delta, behavior: "smooth" });
  };

  // Optimistically empties the section; clearRecentEmojis drops the account's
  // stored stats so it stays empty across reopens (reaction history untouched).
  const handleClearRecent = (e: MouseEvent) => {
    // trusted-gesture gate (see handlePick)
    if (!e.isTrusted) return;
    if (recentUserId) void clearRecentEmojis(recentUserId);
    setRecent([]);
  };

  // Sends the pick to the host and folds the result into local state. Defers the optimistic
  // paint until the host confirms; a rejected pick (auth lost between click and send) leaves
  // no trace of a reaction the server never got.
  const castPick = async (r: Reaction, origin?: ReactionAnimationOrigin) => {
    const nextReaction = mine === r ? null : r;
    const accepted = await onPick(nextReaction, nextReaction ? origin : undefined);
    if (!accepted) return;
    applyDelta(mine, nextReaction);
  };

  const handlePick = async (r: Reaction, ev?: MouseEvent) => {
    // Only a real user gesture may cast a reaction. The picker mounts in an OPEN shadow
    // root inside the page, so any script there - the site itself, an XSS on it, or
    // another extension's content script - can reach these buttons and `.click()` them,
    // which would vote from the signed-in account silently. Keyboard activation of a
    // <button> dispatches a trusted click, so this costs the keyboard path nothing.
    // The residual it does not cover: the host sits in the page's own DOM, so the page can
    // restyle or move it under a real cursor and harvest a genuine click. Bounded by taking
    // two of them through a visible overlay, and no inline mount can do better than that.
    if (!ev?.isTrusted) return;
    // Signed out: keep the popover open and swap the grid for the gate, holding the pick.
    // Nothing is sent and no auth tab opens until the gate's own button is pressed.
    if (!authed) {
      setPendingReaction(r);
      return;
    }
    setOpen(false);
    triggerRef.current?.focus();
    await castPick(r, pickOriginFromEvent(ev));
  };

  // Sign-in landed while the gate held a pick: honour the "Sign in & react" promise and cast
  // it. `authed` only ever flips through the background's auth-change push (bindRefresh), so
  // the page cannot forge this - the trusted click that chose the emoji still gates it.
  useEffect(() => {
    if (!authed || !pendingReaction) return;
    const r = pendingReaction;
    setPendingReaction(null);
    setOpen(false);
    triggerRef.current?.focus();
    void castPick(r, elementOrigin(triggerRef.current));
  }, [authed, pendingReaction]);

  const onTriggerKey = (e: KeyboardEvent) => {
    // trusted-gesture gate (see handlePick)
    if (!e.isTrusted) return;
    if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(true);
    }
  };

  const onTriggerPointer = (e: MouseEvent | PointerEvent) => {
    e.stopPropagation();
  };

  // Signed-out clicks open the popover too, onto the same palette. Picking there
  // swaps in the sign-in gate (see renderGate), and only the gate's own button
  // opens the auth tab.
  const onTriggerClick = (e: MouseEvent) => {
    // trusted-gesture gate (see handlePick)
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    setOpen((v) => !v);
  };

  const filteredEmojis = useMemo(() => {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return null;
    return searchEmojis(trimmedQuery, REACTIONS);
    // `localeVersion` is listed so the filter re-runs when a
    // script-triggered locale fetch lands and `onLocalesChanged` fires.
  }, [query, localeVersion]);

  const { onGridItemKey, onSearchKeyDown } = useGridRovingFocus({ open, itemSetKey: [filteredEmojis, recent, popular], popRef });

  const { counts: displayCounts, total: displayTotal } = deriveOwnReactionDisplay(counts, total, mine);

  const sortedEntries = useMemo(
    () =>
      Object.entries(displayCounts)
        .filter(([, n]) => (n ?? 0) > 0)
        .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0)),
    [displayCounts],
  );

  const visibleBreakdownEntries = useMemo(() => sortedEntries.slice(0, breakdownDisplayLimit), [sortedEntries, breakdownDisplayLimit]);

  const showToggle = sortedEntries.length > BREAKDOWN_INITIAL;
  const isExpanded = breakdownDisplayLimit > BREAKDOWN_INITIAL;

  const handleToggleMore = () => {
    setBreakdownDisplayLimit(isExpanded ? BREAKDOWN_INITIAL : BREAKDOWN_EXPANDED);
  };

  const renderEmoji = (e: string) => <EmojiButton key={e} emoji={e} selected={mine === e} onPick={(r, ev) => void handlePick(r, ev)} onKeyDown={onGridItemKey} />;

  const hasReactions = displayTotal > 0;
  const renderBreakdown = () => (hasReactions ? <ReactionBreakdown entries={visibleBreakdownEntries} mine={mine} showToggle={showToggle} expanded={isExpanded} onToggle={handleToggleMore} onPick={(r, ev) => void handlePick(r, ev)} /> : null);

  const renderGrid = () => (
    <>
      {/* Search-result announcement for screen readers; empty text while not searching
          so plain browsing stays quiet. The visible list itself is not live. */}
      <div class="khasky-emojery-sr-only" role="status">
        {filteredEmojis ? (filteredEmojis.length === 0 ? t("pickerNoMatches", query) : t("searchResultsCount", String(filteredEmojis.length))) : ""}
      </div>
      {filteredEmojis ? (
        filteredEmojis.length === 0 ? (
          <div class="khasky-emojery-empty">{t("pickerNoMatches", query)}</div>
        ) : (
          // biome-ignore lint/a11y/useSemanticElements: a fieldset would drag form semantics/styling into the shadow-DOM picker; role="group" on a div is intentional
          <div class="khasky-emojery-grid" role="group" aria-label={t("pickerSearchResultsGroupAria")}>
            {filteredEmojis.map(renderEmoji)}
          </div>
        )
      ) : (
        <>
          {recent.length > 0 && (
            <EmojiSection
              headingId={`${sectionIdPrefix}-recent`}
              heading={t("pickerRecentlyUsed")}
              action={
                <button type="button" class="khasky-emojery-section-clear" onClick={handleClearRecent}>
                  {t("pickerClearRecent")}
                </button>
              }
            >
              {recent.map(renderEmoji)}
            </EmojiSection>
          )}
          {popular.length > 0 && (
            <EmojiSection headingId={`${sectionIdPrefix}-popular`} heading={t("pickerPopular")}>
              {popular.map(renderEmoji)}
            </EmojiSection>
          )}
          {CATEGORIES.map((cat, i) => (
            <EmojiSection key={cat.nameKey} headingId={`${sectionIdPrefix}-cat-${i}`} heading={t(cat.nameKey)} categoryIndex={i}>
              {cat.emojis.map(renderEmoji)}
            </EmojiSection>
          ))}
        </>
      )}
    </>
  );

  // Shown after a signed-out user has already chosen a reaction: it carries that emoji
  // and asks for the identity the pick needs. The auth tab opens only from the button
  // here, never from the trigger click or the emoji click that led to it.
  const handleGateSignIn = (e: MouseEvent) => {
    // trusted-gesture gate (see handlePick): opening a tab must cost a real click.
    if (!e.isTrusted) return;
    onSignIn();
  };

  const renderGate = (reaction: Reaction) => (
    <div class="khasky-emojery-gate">
      <span class="khasky-emojery-gate-emoji" aria-hidden="true">
        <EmojiImg emoji={reaction} />
      </span>
      <p class="khasky-emojery-gate-title">{t("gateTitle")}</p>
      <p class="khasky-emojery-gate-body">{t("gateBody")}</p>
      <button ref={gateSignInRef} type="button" class="khasky-emojery-gate-btn khasky-emojery-gate-signin" onClick={handleGateSignIn}>
        {t("gateSignInBtn")}
      </button>
      <button type="button" class="khasky-emojery-gate-btn khasky-emojery-gate-cancel" onClick={closePopover}>
        {t("cancelBtn")}
      </button>
    </div>
  );

  // Search box + category nav, sticky inside the scroll container so they stay in reach while
  // the grid scrolls. The nav hides while searching - flat results have no sections to
  // navigate.
  const renderStickyHead = () => (
    <div class={`khasky-emojery-sticky-head${placedAbove ? " khasky-emojery-sticky-head--bottom" : ""}`} ref={stickyHeadRef}>
      <div class="khasky-emojery-search-row">
        <span class="khasky-emojery-search-icon" aria-hidden="true">
          <EmojiImg emoji="🔍" />
        </span>
        <input
          ref={searchRef}
          type="search"
          class="khasky-emojery-search"
          placeholder={t("pickerSearchPlaceholder")}
          value={query}
          onInput={(e) => setQuery((e.currentTarget as HTMLInputElement).value)}
          /* Focusing the search collapses an expanded breakdown - the user signalled
             "find an emoji" mode, so the extra context rows get out of the way. */
          onFocus={() => setBreakdownDisplayLimit(BREAKDOWN_INITIAL)}
          /* Block site-level keyboard shortcuts while typing: sites bind single-letter
             shortcuts (GitHub g/t/c, Twitter j/k/l/r, YouTube f/m/space) on document via
             bubble phase, so a search like "hEart" would otherwise fire them. Tab still
             bubbles, so the document handler can trap focus in the dialog; Escape is
             taken earlier still, in that handler's capture phase (picker-hooks.ts). */
          onKeyDown={onSearchKeyDown}
          onKeyUp={(e) => {
            if (e.key !== "Escape") e.stopPropagation();
          }}
          onKeyPress={(e) => e.stopPropagation()}
          aria-label={t("pickerSearchAriaLabel")}
        />
      </div>
      {!query.trim() && <CategoryBar intensity={categoryColor} onSelect={scrollToCategory} />}
    </div>
  );

  // The popover portals out of this host's shadow tree, so it carries the page font over
  // as the variable picker.css clamps - not as a font-size, which would fork the bounds.
  const popoverTypographyStyle =
    typography?.fontFamily || typography?.fontSize
      ? {
          fontFamily: typography.fontFamily,
          [PAGE_FONT_VAR]: typography.fontSize,
        }
      : undefined;

  return (
    <div class="khasky-emojery-root">
      <PickerTrigger triggerRef={triggerRef} mine={mine} total={displayTotal} topReactions={sortedEntries.slice(0, COUNTER_TRIO_LIMIT).map(([r]) => r)} open={open} onPointer={onTriggerPointer} onClick={onTriggerClick} onKeyDown={onTriggerKey} />

      {open &&
        createPortal(
          <div
            class="khasky-emojery-popover"
            role="dialog"
            // Focus is trapped inside (usePopoverDismiss) and an outside click closes it, so
            // the popover really is modal - without this, AT still offers the page behind it.
            aria-modal="true"
            aria-label={pendingReaction ? t("gateTitle") : t("pickerDialogAria")}
            // Roving tabindex means Tab reaches the grid as ONE stop; the arrow-key model
            // that moves within it has no markup an AT can infer, so it is stated.
            // The gate has no grid, so it carries no keyboard hint.
            aria-describedby={pendingReaction ? undefined : `${sectionIdPrefix}-hint`}
            ref={popRef}
            style={{
              // Render off-screen until the layout effect measures the
              // popover's real size and writes the final coordinates.
              top: popPos ? `${popPos.top}px` : "-9999px",
              left: popPos ? `${popPos.left}px` : "-9999px",
              visibility: popPos ? "visible" : "hidden",
              [CATEGORY_COUNT_VAR]: String(CATEGORIES.length),
              ...popoverTypographyStyle,
            }}
          >
            {pendingReaction ? (
              renderGate(pendingReaction)
            ) : (
              <>
                <p class="khasky-emojery-sr-only" id={`${sectionIdPrefix}-hint`}>
                  {t("pickerKeyboardHint")}
                </p>
                <div class={`khasky-emojery-popover-scroll${placedAbove ? " khasky-emojery-popover-scroll--reversed" : ""}`} ref={scrollRef}>
                  {/* Hide the breakdown while searching - it's noise then and
                      pushes the grid off-screen. */}
                  {!query.trim() && renderBreakdown()}
                  {!query.trim() && hasReactions && <div class="khasky-emojery-popover-divider" aria-hidden="true" />}
                  {/* When the popover opens above the trigger, the sticky head moves below
                      the grid so the search box stays next to the button. */}
                  {placedAbove ? (
                    <>
                      {renderGrid()}
                      {renderStickyHead()}
                    </>
                  ) : (
                    <>
                      {renderStickyHead()}
                      {renderGrid()}
                    </>
                  )}
                </div>
              </>
            )}
          </div>,
          typeof portalRoot === "function" ? portalRoot() : portalRoot,
        )}
    </div>
  );
}

export interface PickerTypography {
  fontFamily?: string;
  fontSize?: string;
}

function pickOriginFromEvent(ev?: MouseEvent): ReactionAnimationOrigin | undefined {
  if (!ev) return undefined;
  if (ev.clientX > 0 || ev.clientY > 0) {
    return { x: ev.clientX, y: ev.clientY };
  }
  const current = ev.currentTarget;
  return current instanceof HTMLElement ? elementOrigin(current) : undefined;
}

// Centre of an element in viewport coordinates - the animation origin when there is no
// click to read one from (keyboard activation, the gate's post-sign-in cast).
function elementOrigin(el: HTMLElement | null): ReactionAnimationOrigin | undefined {
  if (!el) return undefined;
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}
