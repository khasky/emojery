// SPDX-License-Identifier: GPL-3.0-or-later
import { Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { SupportedSite } from "../../shared/adapter";
import { errorCopyKey } from "../../shared/error-copy";
import { t } from "../../shared/i18n";
import type { HistoryStats, ReactionHistoryItem, RuntimeErrorCode } from "../../shared/messages";
import { SITE_LABELS } from "../../shared/sites";
import { sendRuntimeMessage } from "../../shared/webext";
import { EmojiImg } from "../../ui/emoji-img";
import { fmtExactDate, historyDayKey, historyDayLabel } from "./popup-history-dates";
import { SearchField, SignInPrompt, shortenUrl } from "./popup-shared";
import { HoverTooltip, renderUrlParts } from "./popup-tooltip";

// Rows per fetched page; the list grows a page at a time via "Show more", so the
// popup only ever holds what it revealed - history itself is uncapped.
const HISTORY_PAGE = 100;

// Each keystroke is an IndexedDB-scan round-trip; debounce so fast typing sends one request.
const HISTORY_SEARCH_DEBOUNCE_MS = 200;

// `all` clears the bound; the rest map to a `since` epoch-ms lower bound applied to `ts`.
const HISTORY_RANGES = ["all", "today", "7d", "30d", "365d"] as const;
type HistoryRange = (typeof HISTORY_RANGES)[number];

// Emoji chips shown before the strip is expanded. It is a per-emoji tally as much as a
// filter row, so the rest stay one click away rather than silently cut: a truncated strip
// sums to less than the account's history and reads as reactions that went missing.
const HISTORY_FACET_EMOJI_LIMIT = 10;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

function rangeSince(range: HistoryRange): number | undefined {
  const now = Date.now();
  switch (range) {
    case "today": {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0);
      return midnight.getTime();
    }
    case "7d":
      return now - 7 * DAY_MS;
    case "30d":
      return now - 30 * DAY_MS;
    case "365d":
      return now - 365 * DAY_MS;
    default:
      return undefined;
  }
}

function rangeLabel(range: HistoryRange): string {
  switch (range) {
    case "today":
      return t("rangeToday");
    case "7d":
      return t("range7d");
    case "30d":
      return t("range30d");
    case "365d":
      return t("range365d");
    default:
      return t("rangeAll");
  }
}

function historySiteLabel(site: string): string {
  return SITE_LABELS[site as SupportedSite] ?? site;
}

function facetEntries(distribution: Record<string, number>): [string, number][] {
  return Object.entries(distribution).sort((a, b) => b[1] - a[1]);
}

// Counts come from the global distribution - they reflect the whole history,
// not the currently-stacked filters.
const FacetBar = ({ stats, emoji, site, range, onEmoji, onSite, onRange }: { stats: HistoryStats; emoji: string | null; site: SupportedSite | null; range: HistoryRange; onEmoji: (next: string | null) => void; onSite: (next: SupportedSite | null) => void; onRange: (next: HistoryRange) => void }) => {
  const [allEmojiShown, setAllEmojiShown] = useState(false);
  const allEmojiChips = facetEntries(stats.byEmoji);
  const emojiChips = allEmojiShown ? allEmojiChips : allEmojiChips.slice(0, HISTORY_FACET_EMOJI_LIMIT);
  const siteOptions = facetEntries(stats.bySite);
  return (
    <div class="history-facets">
      <div class="facet-selects">
        <select
          class="facet-select"
          aria-label={t("facetSiteAria")}
          value={site ?? ""}
          onChange={(e: Event) => {
            const value = (e.currentTarget as HTMLSelectElement).value;
            onSite(value ? (value as SupportedSite) : null);
          }}
        >
          <option value="">{t("facetAllSites")}</option>
          {siteOptions.map(([s, count]) => (
            <option key={s} value={s}>{`${historySiteLabel(s)} (${count})`}</option>
          ))}
        </select>
        <select class="facet-select" aria-label={t("facetRangeAria")} value={range} onChange={(e: Event) => onRange((e.currentTarget as HTMLSelectElement).value as HistoryRange)}>
          {HISTORY_RANGES.map((rk) => (
            <option key={rk} value={rk}>
              {rangeLabel(rk)}
            </option>
          ))}
        </select>
      </div>
      {emojiChips.length > 0 ? (
        <div class="facet-chips">
          {emojiChips.map(([em, count]) => (
            <button key={em} type="button" class={em === emoji ? "facet-chip facet-chip-active" : "facet-chip"} aria-pressed={em === emoji ? "true" : "false"} onClick={() => onEmoji(em === emoji ? null : em)}>
              <span class="facet-chip-emoji">
                <EmojiImg emoji={em} />
              </span>
              <span class="facet-chip-count">{String(count)}</span>
            </button>
          ))}
          {allEmojiChips.length > HISTORY_FACET_EMOJI_LIMIT ? (
            <button class="linkish" type="button" aria-expanded={allEmojiShown ? "true" : "false"} onClick={() => setAllEmojiShown((shown) => !shown)}>
              {allEmojiShown ? t("pickerShowLess") : t("pickerShowMore")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

// Group consecutive same-day rows (newest-first) under a day header. Each day is its own
// <ul> with the header <div> outside it, so `.history li` keeps meaning "a reaction".
const HistoryList = ({ items }: { items: ReactionHistoryItem[] }) => {
  const groups: { key: string; label: string; rows: ReactionHistoryItem[] }[] = [];
  for (const row of items) {
    const key = historyDayKey(row.ts);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.rows.push(row);
    else groups.push({ key, label: historyDayLabel(row.ts), rows: [row] });
  }

  return (
    <Fragment>
      {groups.map((group) => (
        <Fragment key={group.key}>
          {/* aria-level 2: the popup's only real heading above this is the <h1> brand title. */}
          {/* biome-ignore lint/a11y/useSemanticElements: a real <h2> between the day groups would sit inside the list flow and break `.history li` meaning exactly one reaction row */}
          <div class="history-day" role="heading" aria-level={2}>
            {group.label}
          </div>
          <ul>
            {group.rows.map((row) => (
              <li
                // Stable row identity so Preact reuses row DOM across page appends
                // and query switches - an index key would remap every row.
                key={row.id ?? row.historyId ?? `${row.ts}:${row.target.url}`}
                // Tint the row by what the click did; legacy rows stay untinted.
                class={row.action ? `history-${row.action}` : undefined}
              >
                <span class="history-emoji">
                  <EmojiImg emoji={row.reaction} />
                </span>
                {/* URL first line, captured title second; rows recorded before titles existed show one line. */}
                <div class="history-mid">
                  <HoverTooltip variant="link" wrapClass="history-link" href={row.target.url} trigger={shortenUrl(row.target.url)} content={() => renderUrlParts(row.target.url)} />
                  {row.title ? (
                    <span class="history-title" title={row.title}>
                      {row.title}
                    </span>
                  ) : null}
                </div>
                <HoverTooltip variant="text" wrapClass="history-time" trigger={fmtRelative(row.ts)} content={() => <span class="tt-date">{fmtExactDate(row.ts)}</span>} />
              </li>
            ))}
          </ul>
        </Fragment>
      ))}
    </Fragment>
  );
};

const HistoryView = () => {
  // Pages fetched so far (already background-filtered) + the cursor for the next "Show more".
  const [items, setItems] = useState<ReactionHistoryItem[]>([]);
  const [cursor, setCursor] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [emoji, setEmoji] = useState<string | null>(null);
  const [site, setSite] = useState<SupportedSite | null>(null);
  const [range, setRange] = useState<HistoryRange>("all");
  const [loading, setLoading] = useState(true);
  const [stats, setStats] = useState<HistoryStats | null>(null);
  // `null` = still loading; drives which empty-state copy shows.
  const [authed, setAuthed] = useState<boolean | null>(null);
  // A page the background could not read. Kept apart from `authed`: rendering the
  // sign-in prompt for a failed read told a signed-in user to sign in again.
  // Null when the last read succeeded; otherwise the background's classification, so the
  // banner can say "offline" or "slow down" instead of one generic line (shared/error-copy.ts).
  const [failed, setFailed] = useState<RuntimeErrorCode | null>(null);
  // Monotonic request stamp: a slow earlier page/search response must never
  // overwrite the state a newer request produced.
  const requestSeq = useRef(0);

  const loadPage = (opts: { reset: boolean; cursor: number | null; query: string; emoji: string | null; site: SupportedSite | null; since: number | undefined }) => {
    const seq = ++requestSeq.current;
    setLoading(true);
    void sendRuntimeMessage({
      type: "history:page",
      limit: HISTORY_PAGE,
      ...(opts.query ? { query: opts.query } : {}),
      ...(opts.emoji ? { emoji: opts.emoji } : {}),
      ...(opts.site ? { site: opts.site } : {}),
      ...(opts.since != null ? { since: opts.since } : {}),
      ...(opts.cursor === null ? {} : { cursor: opts.cursor }),
    })
      .then((resp) => {
        if (requestSeq.current !== seq) return;
        if (resp?.type === "history:page") {
          setFailed(null);
          setAuthed(resp.authed);
          setItems((prev) => (opts.reset ? resp.items : [...prev, ...resp.items]));
          setCursor(resp.cursor);
        } else {
          setFailed(resp?.type === "error" ? resp.code : "unavailable");
        }
        setLoading(false);
      })
      .catch(() => {
        if (requestSeq.current !== seq) return;
        setFailed("unavailable");
        setLoading(false);
      });
  };

  // Two derived forms, computed once so the request path and the empty-state checks
  // can never disagree: `trimmedQuery` answers "is a filter active", `normalizedQuery`
  // is what the background matches against (it trims + lowercases again anyway).
  const trimmedQuery = query.trim();
  const normalizedQuery = trimmedQuery.toLowerCase();

  // Stats are fetched once per HistoryView mount. main.tsx renders the view conditionally, so
  // switching tabs unmounts it and coming back re-sends history:stats.
  useEffect(() => {
    void sendRuntimeMessage({ type: "history:stats" })
      .then((resp) => {
        if (resp?.type === "history:stats" && resp.authed) setStats(resp.stats);
      })
      // Swallowed: stats only feed the facet bar, which stays hidden while `stats`
      // is null - the list is the primary content and reports its own load errors.
      .catch(() => {});
  }, []);

  // Only free-text typing is debounced; facet toggles apply immediately.
  useEffect(() => {
    const run = () => loadPage({ reset: true, cursor: null, query: normalizedQuery, emoji, site, since: rangeSince(range) });
    const timer = setTimeout(run, normalizedQuery ? HISTORY_SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
  }, [normalizedQuery, emoji, site, range]);

  if (failed !== null) {
    return (
      <section class="history empty">
        <p role="alert">{t(errorCopyKey(failed, "loadError"))}</p>
      </section>
    );
  }
  if (authed === false) {
    return <SignInPrompt message={t("signInMsgHistory")} />;
  }
  if (authed === null) return null;

  const hasFilter = !!(trimmedQuery || emoji || site || range !== "all");

  // First-run empty state: no reactions and nothing filtered away, so no search box or facets.
  if (!hasFilter && items.length === 0 && !loading) {
    return (
      <section class="history empty">
        <p>{t("historyEmpty")}</p>
      </section>
    );
  }

  // Facets show whenever the account has any history, so a filter that empties
  // the list still leaves the controls to clear it.
  const facets = stats && stats.total > 0 ? <FacetBar stats={stats} emoji={emoji} site={site} range={range} onEmoji={setEmoji} onSite={setSite} onRange={setRange} /> : null;

  const search = (
    <Fragment>
      <SearchField wrapClass="history-search" inputClass="history-search-input" placeholder={t("historySearchPlaceholder")} value={query} onInput={setQuery} />
      {/* Screen-reader announcement of filter results (only while a filter is active,
          so plain browsing stays quiet); the list itself is not live. */}
      <span class="sr-only" role="status">
        {loading || !hasFilter ? "" : items.length === 0 ? t("historyNoMatches") : t("searchResultsCount", String(items.length))}
      </span>
    </Fragment>
  );

  if (items.length === 0) {
    return (
      <section class="history">
        {search}
        {facets}
        {loading ? null : <p class="history-nomatch">{t("historyNoMatches")}</p>}
      </section>
    );
  }

  return (
    <section class="history">
      {search}
      {facets}
      <HistoryList items={items} />
      {cursor !== null ? (
        <div class="history-more">
          <button class="linkish" type="button" disabled={loading} onClick={() => loadPage({ reset: false, cursor, query: normalizedQuery, emoji, site, since: rangeSince(range) })}>
            {t("pickerShowMore")}
          </button>
        </div>
      ) : null}
    </section>
  );
};

function fmtRelative(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / MINUTE_MS);
  if (minutes < 1) return t("relativeJustNow");
  if (minutes < 60) return t("relativeMinutes", String(minutes));
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("relativeHours", String(hours));
  return t("relativeDays", String(Math.floor(hours / 24)));
}

export { HistoryView };
