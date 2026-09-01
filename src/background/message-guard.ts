// SPDX-License-Identifier: GPL-3.0-or-later
//
// Sender trust + payload validation for the background message router.
import type { TargetRef } from "../shared/adapter";
import { defined } from "../shared/defined";
import { normalizeLanguageTag } from "../shared/language-tag";
import { EMAIL_MAX, HISTORY_IMPORT_MAX, NOTE_MAX, OTP_CODE_MAX, type PortableHistoryRow, REACTION_BYTES_MAX, type ReactionAction, type RuntimeMessage, TITLE_MAX } from "../shared/messages";
import { ALL_SITES, detectSupportedSite, type SupportedSite, targetUrlBelongsToSite } from "../shared/sites";

const CONTENT_SCRIPT_MESSAGE_TYPES: ReadonlySet<RuntimeMessage["type"]> = new Set(["vote", "fetchCount", "ui:injected"]);

// Types only the extension's own pages (popup/auth) send - never content scripts.
// The OTP pair matters most: it is the one exchange that MINTS a credential, so a
// content script on any supported site must never be able to drive it.
const EXTENSION_PAGE_MESSAGE_TYPES: ReadonlySet<RuntimeMessage["type"]> = new Set(["report", "history:page", "history:stats", "history:export", "history:import", "auth:signOut", "auth:delete", "auth:requestOtp", "auth:verifyOtp"]);

const MESSAGE_TYPES: ReadonlySet<RuntimeMessage["type"]> = new Set([...CONTENT_SCRIPT_MESSAGE_TYPES, ...EXTENSION_PAGE_MESSAGE_TYPES, "auth:status", "auth:openTab"]);

const SITE_IDS: ReadonlySet<string> = new Set(ALL_SITES);
const TARGET_ID_MAX = 512;
const URL_MAX = 2048;
const HOST_MAX = 256;
// The four exported below are read by message-guard.test.ts, which probes each
// boundary as `limit + 1`. A hand-copied number there keeps passing while quietly
// testing nothing the day a limit shrinks under it.
export const TARGET_COUNT_MAX = 10_000;
export const FETCH_LIMIT_MAX = 50;
export const HISTORY_PAGE_LIMIT_MAX = 500;
export const HISTORY_QUERY_MAX = 256;
const HISTORY_ACTIONS: ReadonlySet<string> = new Set<ReactionAction>(["add", "remove", "change"]);

const encoder = new TextEncoder();

// Extension pages (popup/auth) message from the extension's own origin; the
// auth page runs in a tab, so this is an origin check, not a tab check.
export function isExtensionPageSender(sender: chrome.runtime.MessageSender, extensionBaseUrl: string): boolean {
  return extensionBaseUrl.length > 0 && !!sender.url?.startsWith(extensionBaseUrl);
}

export function isTrustedSender(msgType: RuntimeMessage["type"], sender: chrome.runtime.MessageSender, runtimeId: string, extensionBaseUrl: string): boolean {
  if (sender.id !== runtimeId) return false;
  if (CONTENT_SCRIPT_MESSAGE_TYPES.has(msgType) && sender.tab?.id === undefined) {
    return false;
  }
  if (EXTENSION_PAGE_MESSAGE_TYPES.has(msgType) && !isExtensionPageSender(sender, extensionBaseUrl)) {
    return false;
  }
  return true;
}

export function parseRuntimeMessage(raw: unknown, sender: chrome.runtime.MessageSender, runtimeId: string, extensionBaseUrl: string): RuntimeMessage | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (!isRuntimeMessageType(type)) return null;
  if (!isTrustedSender(type, sender, runtimeId, extensionBaseUrl)) return null;

  switch (type) {
    case "vote": {
      const target = parseTarget(raw.target, sender);
      const reaction = parseVoteReaction(raw.reaction);
      const prevReaction = parseVoteReaction(raw.prevReaction);
      if (!target || reaction === undefined || prevReaction === undefined) return null;
      const lang = normalizeLanguageTag(raw.lang);
      const title = parseOptionalString(raw.title, TITLE_MAX);
      if (title === null) return null;
      // `defined` and not a truthiness spread: `reaction` may legitimately be null
      // (un-react) and must survive. Both optional parsers above answer `undefined`
      // for an empty value, so nothing here can arrive as "".
      return defined({ type, target, reaction, prevReaction, lang, title });
    }
    case "fetchCount": {
      const target = parseTarget(raw.target, sender);
      const limit = parseOptionalInt(raw.limit, 1, FETCH_LIMIT_MAX);
      if (!target || limit === null) return null;
      return defined({ type, target, limit });
    }
    case "report": {
      const site = parseSite(raw.site);
      const host = parseString(raw.host, HOST_MAX);
      const url = parseHttpsUrl(raw.url);
      const targetCount = parseRequiredInt(raw.targetCount, 0, TARGET_COUNT_MAX);
      const note = parseOptionalString(raw.note, NOTE_MAX);
      if (!site || !host || !url || targetCount === null || note === null) return null;
      return defined({ type, site, host, url, targetCount, note });
    }
    case "ui:injected": {
      const targetCount = parseRequiredInt(raw.targetCount, 0, TARGET_COUNT_MAX);
      return targetCount === null ? null : { type, targetCount };
    }
    case "history:page": {
      const cursor = parseOptionalInt(raw.cursor, 1, Number.MAX_SAFE_INTEGER);
      const limit = parseOptionalInt(raw.limit, 1, HISTORY_PAGE_LIMIT_MAX);
      const query = parseOptionalString(raw.query, HISTORY_QUERY_MAX);
      const site = parseOptionalSite(raw.site);
      const emoji = parseOptionalReaction(raw.emoji);
      const since = parseOptionalInt(raw.since, 0, Number.MAX_SAFE_INTEGER);
      if (cursor === null || limit === null || query === null || site === null || emoji === null || since === null) return null;
      // Every facet is absent-or-valid by this line (`null` was the reject signal and
      // is gone), so the whole block is one definedness filter. `since: 0` is a real
      // bound and survives, which a truthiness guard would have dropped.
      return defined({ type, cursor, limit, query, site, emoji, since });
    }
    case "history:import": {
      if (!Array.isArray(raw.rows) || raw.rows.length > HISTORY_IMPORT_MAX) return null;
      const rows: PortableHistoryRow[] = [];
      for (const candidate of raw.rows) {
        const row = parsePortableHistoryRow(candidate);
        if (!row) return null;
        rows.push(row);
      }
      return { type, rows };
    }
    case "auth:requestOtp": {
      const email = parseString(raw.email, EMAIL_MAX);
      return email ? { type, email } : null;
    }
    case "auth:verifyOtp": {
      const email = parseString(raw.email, EMAIL_MAX);
      const code = parseString(raw.code, OTP_CODE_MAX);
      if (!email || !code) return null;
      return { type, email, code };
    }
    case "history:export":
    case "history:stats":
    case "auth:status":
    case "auth:openTab":
    case "auth:signOut":
    case "auth:delete":
      return { type };
  }
  // Unreachable: the switch covers every RuntimeMessage type; a new one fails to compile here.
  return type satisfies never;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRuntimeMessageType(value: unknown): value is RuntimeMessage["type"] {
  return typeof value === "string" && MESSAGE_TYPES.has(value as RuntimeMessage["type"]);
}

// The site a content-script sender is entitled to speak for, derived from the
// frame it runs in. Null for an extension page (popup/auth), which sends no
// target-bearing message, and for an unreadable/unsupported host.
function senderSite(sender: chrome.runtime.MessageSender): SupportedSite | null {
  if (!sender.url) return null;
  try {
    return detectSupportedSite(new URL(sender.url).hostname);
  } catch {
    return null;
  }
}

// Every target-bearing message comes from a per-site content script, so the claimed
// `site` must be the one the sender actually runs on - otherwise a content script
// compromised on one site could write votes and counts attributed to any other. The
// URL is held to the same claim (adapters only emit canonical on-site URLs), so a
// stored target can never point off-site. This is the runtime gate for every site;
// `adapters/target-contract.ts` is the TEST contract that pins the same host-gating
// for the URL-derivable sites (nothing in the shipped bundle imports it).
function parseTarget(value: unknown, sender: chrome.runtime.MessageSender): TargetRef | null {
  if (!isRecord(value)) return null;
  const site = parseSite(value.site);
  const targetId = parseString(value.targetId, TARGET_ID_MAX);
  const url = parseHttpsUrl(value.url);
  if (!site || !targetId || !url) return null;
  if (!targetUrlBelongsToSite(url, site)) return null;
  return site === senderSite(sender) ? { site, targetId, url } : null;
}

// One row of an import file - untrusted user-supplied JSON, so every field is held to
// the bounds a live vote passes and one malformed row rejects the whole import. The
// host gate matters most: this is the only path where a target URL does not come from
// an adapter, and the popup renders every history row as a clickable link.
function parsePortableHistoryRow(value: unknown): PortableHistoryRow | null {
  if (!isRecord(value)) return null;
  const site = parseSite(value.site);
  const targetId = parseString(value.targetId, TARGET_ID_MAX);
  const targetUrl = parseHttpsUrl(value.targetUrl);
  const reaction = normalizeReaction(value.reaction);
  const ts = parseRequiredInt(value.ts, 0, Number.MAX_SAFE_INTEGER);
  const action = parseHistoryAction(value.action);
  if (!site || !targetId || !targetUrl || !reaction || ts === null || action === null) return null;
  if (!targetUrlBelongsToSite(targetUrl, site)) return null;
  return defined({ site, targetId, targetUrl, reaction, ts, action });
}

function parseHistoryAction(value: unknown): ReactionAction | null | undefined {
  if (value === undefined) return undefined;
  return typeof value === "string" && HISTORY_ACTIONS.has(value) ? (value as ReactionAction) : null;
}

function parseSite(value: unknown): SupportedSite | null {
  return typeof value === "string" && SITE_IDS.has(value) ? (value as SupportedSite) : null;
}

// Optional facet variants for history:page - `undefined` = absent (omit),
// `null` = present-but-invalid (reject the whole message).
function parseOptionalSite(value: unknown): SupportedSite | null | undefined {
  if (value === undefined) return undefined;
  return parseSite(value);
}

// One emoji, or null when the value is not a usable one. Trimmed, not just
// tested for emptiness: a padded " 👍" would otherwise travel as a key distinct
// from "👍" through the vote body, history and recents. The required-field
// parser - callers that need "absent" or "un-react" wrap it below. Exported for
// api-read.ts, which holds API response emoji to the same rule before they
// enter the counts cache.
export function normalizeReaction(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const emoji = value.trim();
  if (!emoji) return null;
  return encoder.encode(emoji).length <= REACTION_BYTES_MAX ? emoji : null;
}

function parseOptionalReaction(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  return normalizeReaction(value);
}

// The ONE place the convention above is inverted, forced by the domain: on a
// vote `null` is a legal value (un-react), so it cannot double as the rejection
// signal. Here `null` means un-react and `undefined` means reject.
function parseVoteReaction(value: unknown): string | null | undefined {
  if (value === null) return null;
  return normalizeReaction(value) ?? undefined;
}

function parseString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

function parseOptionalString(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return undefined;
  return text.length <= max ? text : null;
}

function parseHttpsUrl(value: unknown): string | null {
  const text = parseString(value, URL_MAX);
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? text : null;
  } catch {
    return null;
  }
}

function parseRequiredInt(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  return value >= min && value <= max ? value : null;
}

function parseOptionalInt(value: unknown, min: number, max: number): number | null | undefined {
  if (value === undefined) return undefined;
  return parseRequiredInt(value, min, max);
}
