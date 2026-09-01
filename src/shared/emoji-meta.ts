// SPDX-License-Identifier: GPL-3.0-or-later
//
// Localized emoji metadata from Unicode CLDR via emojibase-data. Two-tier
// lookup: the user's browser locale with English as the universal fallback -
// both feed `searchEmojis`, so "love", "amour", "愛" or "любовь" all find ❤️.
// MV3 content scripts have no code-splitting, so importing this data would inline
// the whole multi-megabyte CLDR set into every one: `scripts/copy-emoji-locales.mjs`
// instead prunes it to the picker's REACTIONS entries, emitting `public/emoji-data/<locale>.json`,
// ALL fetched at runtime via `chrome.runtime.getURL` - English included.
import { API_TIMEOUT_MS } from "./config";
import { deadlineSignal } from "./fetch-deadline";

interface CompactEmoji {
  unicode?: string;
  label?: string;
  tags?: string[];
  skins?: CompactEmoji[];
}

interface EmojiInfo {
  label: string;
  /** Label + keyword tags, lowercased and space-joined once at load, so the search
   * path doesn't re-lowercase every candidate's label and tags on each keystroke.
   * Space-joined so the word-start matcher below still sees each tag as its own word. */
  search: string;
}

// emojibase-data bakes a U+FE0F (variation selector-16) into many root
// entries' `unicode`, while our reactions catalog uses the canonical
// short forms for some of those - so a direct `Map.get(emoji)` misses. Register
// every entry under BOTH the original and the VS-16-stripped key; both point at
// the same `EmojiInfo` object, no memory overhead.
function addEntry(map: Map<string, EmojiInfo>, key: string | undefined, info: EmojiInfo): void {
  if (!key) return;
  map.set(key, info);
  const stripped = key.replace(/\uFE0F/g, "");
  if (stripped && stripped !== key) map.set(stripped, info);
}

function toInfo(entry: CompactEmoji): EmojiInfo {
  const label = entry.label ?? "";
  const tags = entry.tags ?? [];
  return { label, search: [label, ...tags].join(" ").toLowerCase() };
}

function buildMap(compactEntries: readonly CompactEmoji[]): Map<string, EmojiInfo> {
  const byEmoji = new Map<string, EmojiInfo>();
  for (const compactEntry of compactEntries) {
    if (!compactEntry.unicode) continue;
    addEntry(byEmoji, compactEntry.unicode, toInfo(compactEntry));
    if (compactEntry.skins) {
      for (const skin of compactEntry.skins) {
        if (!skin.unicode) continue;
        addEntry(byEmoji, skin.unicode, toInfo(skin));
      }
    }
  }
  return byEmoji;
}

let enMap: Map<string, EmojiInfo> | null = null;
let enMapPromise: Promise<Map<string, EmojiInfo> | null> | null = null;

export function ensureEnLoaded(): Promise<Map<string, EmojiInfo> | null> {
  if (enMap) return Promise.resolve(enMap);
  enMapPromise ??= (async () => {
    const data = await fetchLocaleData("en");
    if (!data) {
      // A failed fetch may be transient (worker not ready); allow a retry.
      enMapPromise = null;
      return null;
    }
    enMap = buildMap(data);
    notifyLocaleChanged();
    return enMap;
  })();
  return enMapPromise;
}

// Patches a CLDR gap: German ❤️ carries only "rotes Herz"/"herz", so the obvious
// query for the most-used emoji would otherwise find nothing.
const SUPPLEMENTAL_SEARCH_TAGS = new Map<string, readonly string[]>([
  ["\u2764\uFE0F", ["liebe"]],
  ["\u2764", ["liebe"]],
]);

// primaryLocaleMap holds the browser-locale data - the ONLY non-English
// source `getEmojiLabel` consults, so displayed labels always follow the
// browser language. searchExtraMaps holds locales fetched because the search
// query contains their script (e.g. JA/ZH for a CJK ideograph); consulted by
// `searchEmojis` only, never for labels.
let primaryLocaleMap: Map<string, EmojiInfo> | null = null;
let primaryLocaleKey: string | null = null;
const searchExtraMaps = new Map<string, Map<string, EmojiInfo>>();
const inflightLoads = new Map<string, Promise<Map<string, EmojiInfo> | null>>();

// Locales we ship emoji metadata for. `en` is absent on purpose - it loads
// through ensureEnLoaded() as the universal fallback, not through this set;
// regional near-duplicates fall back to the base language via normalizeKey().
const SUPPORTED_LOCALE_KEYS: ReadonlySet<string> = new Set(["bn", "da", "de", "es", "et", "fi", "fr", "hi", "hu", "it", "ja", "ko", "lt", "ms", "nb", "nl", "pl", "pt", "ru", "sv", "th", "uk", "vi", "zh", "zh-hant"]);

// Traditional Chinese reaches us as a region tag (zh-TW/HK/MO) far more often than as an
// explicit script tag, and every one of those splits to a bare "zh" - i.e. Simplified data
// for a Traditional UI. Match the script before the base-language fallback runs.
const ZH_HANT_TAG_RE = /^zh[-_](hant|tw|hk|mo)\b/;

function normalizeKey(raw: string): string | null {
  const lower = raw.toLowerCase();
  if (SUPPORTED_LOCALE_KEYS.has(lower)) return lower;
  if (ZH_HANT_TAG_RE.test(lower)) return "zh-hant";
  const base = lower.split(/[-_]/)[0];
  if (base && SUPPORTED_LOCALE_KEYS.has(base)) return base;
  return null;
}

function detectLocaleKey(): string | null {
  if (typeof navigator === "undefined") return null;
  const candidates = navigator.languages?.length ? navigator.languages : navigator.language ? [navigator.language] : [];
  for (const cand of candidates) {
    const key = normalizeKey(cand);
    if (key) return key;
  }
  return null;
}

// Unicode script ranges mapped to the locales likely to label emojis in that
// script, so an English-browser user can still type `愛` or `любовь`.
// `spaceless` marks the scripts that write words without spaces (see
// isSpacelessScriptQuery below).
const SCRIPT_RANGES: readonly { from: number; to: number; locales: readonly string[]; spaceless: boolean }[] = [
  { from: 0x4e00, to: 0x9fff, locales: ["ja", "zh"], spaceless: true }, // CJK Unified Ideographs
  { from: 0x3040, to: 0x309f, locales: ["ja", "zh"], spaceless: true }, // Hiragana
  { from: 0x30a0, to: 0x30ff, locales: ["ja", "zh"], spaceless: true }, // Katakana
  { from: 0xac00, to: 0xd7af, locales: ["ko"], spaceless: true }, // Hangul
  { from: 0x0e00, to: 0x0e7f, locales: ["th"], spaceless: true }, // Thai
  { from: 0x0400, to: 0x04ff, locales: ["ru", "uk"], spaceless: false }, // Cyrillic
  { from: 0x0900, to: 0x097f, locales: ["hi"], spaceless: false }, // Devanagari
  { from: 0x0980, to: 0x09ff, locales: ["bn"], spaceless: false }, // Bengali
];

function localesForQuery(query: string): string[] {
  const keys = new Set<string>();
  for (const ch of query) {
    const codePoint = ch.codePointAt(0) ?? 0;
    for (const range of SCRIPT_RANGES) {
      if (codePoint >= range.from && codePoint <= range.to) for (const key of range.locales) keys.add(key);
    }
  }
  return [...keys].filter((localeKey) => SUPPORTED_LOCALE_KEYS.has(localeKey));
}

function getResourceUrl(path: string): string | null {
  // Guarded because this module also runs under Vitest/node, where `chrome` is
  // undefined (same reason as shared/i18n.ts's fallback).
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(path);
    }
  } catch {}
  return null;
}

async function fetchLocaleData(key: string): Promise<CompactEmoji[] | null> {
  const url = getResourceUrl(`emoji-data/${key}.json`);
  if (!url) return null;
  try {
    // Deadline: `inflightLoads` memoizes this promise, so a hang would pin the
    // locale as forever-loading for the page's lifetime.
    const signal = deadlineSignal(API_TIMEOUT_MS);
    const res = await fetch(url, signal ? { signal } : {});
    if (!res.ok) return null;
    return (await res.json()) as CompactEmoji[];
  } catch {
    // Localized emoji names are an enhancement - readers fall back to the emoji
    // character until the English map lands (also fetched, see the header). This
    // runs in a content script, so the failure stays unlogged rather than
    // writing into the host page's console.
    return null;
  }
}

type LoadKind = "primary" | "search-extra";

// Hand a settled map the primary role: getEmojiLabel reads primaryLocaleMap only,
// so a locale that arrived as a search-extra has to move over - and stop being
// consulted as an extra - before the picker re-renders on it.
function promoteToPrimary(key: string, map: Map<string, EmojiInfo>): void {
  primaryLocaleMap = map;
  primaryLocaleKey = key;
  searchExtraMaps.delete(key);
  notifyLocaleChanged();
}

function loadLocaleMap(key: string, kind: LoadKind): Promise<Map<string, EmojiInfo> | null> {
  if (key === "en") return ensureEnLoaded();
  if (kind === "primary" && primaryLocaleKey === key && primaryLocaleMap) {
    return Promise.resolve(primaryLocaleMap);
  }
  const cachedExtra = searchExtraMaps.get(key);
  if (cachedExtra) {
    // Settled as a search-extra, now asked for as the primary.
    if (kind === "primary" && primaryLocaleKey !== key) promoteToPrimary(key, cachedExtra);
    return Promise.resolve(cachedExtra);
  }
  const inflight = inflightLoads.get(key);
  if (inflight) {
    if (kind === "primary") {
      return inflight.then((map) => {
        if (map && primaryLocaleKey !== key) promoteToPrimary(key, map);
        return map;
      });
    }
    return inflight;
  }
  const pending = (async () => {
    // Memoized forever on purpose: an unsupported locale never becomes supported.
    if (!SUPPORTED_LOCALE_KEYS.has(key)) return null;
    const data = await fetchLocaleData(key);
    if (!data) {
      // A failed fetch may be transient (worker not ready); drop the memo so the
      // next call retries, exactly as ensureEnLoaded does for English. Leaving it
      // in strands this locale - labels AND search - for the page's lifetime.
      inflightLoads.delete(key);
      return null;
    }
    const map = buildMap(data);
    if (kind === "primary") {
      primaryLocaleMap = map;
      primaryLocaleKey = key;
    } else {
      searchExtraMaps.set(key, map);
    }
    return map;
  })();
  inflightLoads.set(key, pending);
  return pending;
}

/**
 * Kick off the user-locale load (`navigator.languages`); resolves once the
 * primary locale is in memory. Repeated calls share one promise per locale key.
 */
export async function ensureLocaleLoaded(): Promise<Map<string, EmojiInfo> | null> {
  const key = detectLocaleKey();
  // The English fallback loads alongside (or alone, for unsupported locales):
  // it is the universal search/label floor, awaited here so a caller that
  // awaited this can search in English immediately.
  const en = ensureEnLoaded();
  const primary = key ? loadLocaleMap(key, "primary") : Promise.resolve(null);
  const [primaryMap] = await Promise.all([primary, en]);
  return primaryMap;
}

/**
 * Localized name for an emoji: primary browser-locale map, then English, then
 * the emoji character itself. Search-extra locales are intentionally NOT
 * consulted - displayed labels follow the browser language, not what the user
 * happens to be typing.
 */
export function getEmojiLabel(emoji: string): string {
  // ensureLocaleLoaded, not ensureEnLoaded: the popup enters this module through
  // labels and search only, so an English-only kick-off strands every non-English UI.
  if (!primaryLocaleMap) void ensureLocaleLoaded();
  return primaryLocaleMap?.get(emoji)?.label || enMap?.get(emoji)?.label || emoji;
}

// Scripts that write words without spaces (CJK ideographs, kana, Hangul, Thai)
// keep substring matching - "word start" is meaningless there. Space-delimited
// scripts require the query at a word start, so "love" stops matching inside
// "clover" / "glove".
function isSpacelessScriptQuery(needle: string): boolean {
  for (const ch of needle) {
    const codePoint = ch.codePointAt(0) ?? 0;
    if (SCRIPT_RANGES.some((range) => range.spaceless && codePoint >= range.from && codePoint <= range.to)) return true;
  }
  return false;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Per-query matcher; `needle` is trimmed + lowercased and every text passed in
// must be lowercased too.
function buildQueryMatcher(needle: string): (text: string) => boolean {
  if (isSpacelessScriptQuery(needle)) {
    return (text) => text.includes(needle);
  }
  // `needle` is escaped, so it contributes literals only.
  // nosemgrep: javascript.lang.security.audit.detect-non-literal-regexp.detect-non-literal-regexp
  const atWordStart = new RegExp(`(?:^|[^\\p{L}\\p{N}])${escapeRegExp(needle)}`, "u");
  return (text) => atWordStart.test(text);
}

/**
 * Filter `candidates` by localized label and keyword tags. A query in a
 * non-Latin script lazy-loads the locales using that script, so English-browser
 * users can still type `愛` / `любовь` / `사랑` and find ❤️; the maps apply on
 * the caller's next search after the fetch resolves. Empty query returns [] -
 * the caller treats that as "show categories".
 */
export function searchEmojis(query: string, candidates: readonly string[]): string[] {
  const trimmed = query.trim();
  const needle = trimmed.toLowerCase();
  if (!needle) return [];

  if (!primaryLocaleMap) void ensureLocaleLoaded(); // browser locale + English, see getEmojiLabel
  // Fire-and-forget: loaded maps land in searchExtraMaps and
  // notifyLocaleChanged() lets the Picker recompute the search once data lands.
  for (const key of localesForQuery(trimmed)) {
    if (key === primaryLocaleKey) continue;
    if (searchExtraMaps.has(key)) continue;
    if (inflightLoads.has(key)) continue;
    void loadLocaleMap(key, "search-extra").then((loaded) => {
      if (loaded) notifyLocaleChanged();
    });
  }

  const matchesText = buildQueryMatcher(needle);
  const matchesInfo = (info: EmojiInfo): boolean => !!info.search && matchesText(info.search);
  return candidates.filter((emoji) => {
    if (emoji.includes(needle)) return true;
    if (SUPPLEMENTAL_SEARCH_TAGS.get(emoji)?.some((tag) => matchesText(tag))) {
      return true;
    }
    if (primaryLocaleMap) {
      const info = primaryLocaleMap.get(emoji);
      if (info && matchesInfo(info)) return true;
    }
    for (const map of searchExtraMaps.values()) {
      const info = map.get(emoji);
      if (info && matchesInfo(info)) return true;
    }
    const en = enMap?.get(emoji);
    if (en && matchesInfo(en)) return true;
    return false;
  });
}

type LocaleChangedCb = () => void;
const localeChangedListeners = new Set<LocaleChangedCb>();

function notifyLocaleChanged(): void {
  for (const cb of localeChangedListeners) {
    try {
      cb();
    } catch {
      /* ignore listener throws */
    }
  }
}

// Subscribe to "a new locale map just finished loading" events. The
// Picker uses this to re-run the search filter once data is in.
export function onLocalesChanged(cb: LocaleChangedCb): () => void {
  localeChangedListeners.add(cb);
  return () => localeChangedListeners.delete(cb);
}
