// SPDX-License-Identifier: GPL-3.0-or-later

import type { SupportedSite, TargetRef } from "./adapter";
import type { Reaction, TargetCounts } from "./reactions";

// Max length of the vote message's `title`. Lives with the message shape, not
// with either side of the wire: the content script truncates to it before
// sending (ui/vote-client.ts) and the background rejects a longer one outright
// (background/message-guard.ts), so the two must read the same number.
export const TITLE_MAX = 300;

// Max length of a problem report's free-text note - same contract as TITLE_MAX, enforced by
// popup-report.tsx and background/message-guard.ts.
export const NOTE_MAX = 500;

// Max rows accepted from one history import file - same contract as TITLE_MAX, enforced by
// popup-history-data.tsx and background/message-guard.ts. The import is one IndexedDB
// transaction the popup blocks on, which is why it is not larger.
export const HISTORY_IMPORT_MAX = 100_000;

// Bounds on the two OTP fields. Length only, on purpose: what makes an address or
// a code VALID is the server's call (the auth page pre-empts nothing beyond an
// obviously malformed address), so the guard holds them to a size, not a shape.
// The email ceiling comfortably exceeds any deliverable address.
export const EMAIL_MAX = 320;
export const OTP_CODE_MAX = 12;

// Max UTF-8 bytes of one reaction emoji - same contract on both directions of the
// wire: the background rejects a larger inbound one (background/message-guard.ts)
// and drops a larger one from an API response (background/api-read.ts).
export const REACTION_BYTES_MAX = 32;

export type RuntimeMessage =
  | {
      type: "vote";
      target: TargetRef;
      reaction: Reaction | null;
      prevReaction: Reaction | null;
      /** Page/browser language fallback. */
      lang?: string;
      /** Page title at click time - stored device-locally for the History list, never sent to the server. */
      title?: string;
    }
  | { type: "fetchCount"; target: TargetRef; limit?: number }
  | {
      type: "report";
      site: string;
      host: string;
      url: string;
      targetCount: number;
      note?: string;
    }
  // One page of the signed-in account's reaction history, newest first.
  // `cursor` continues a previous page; `query`/`site`/`emoji`/`since` narrow
  // it in the background (AND) - the popup never holds more than the pages it
  // fetched. `since` is an epoch-ms lower bound on `ts`.
  | { type: "history:page"; cursor?: number; limit?: number; query?: string; site?: SupportedSite; emoji?: Reaction; since?: number }
  // Device-local aggregates over the account's whole history for the History
  // tab's facet chips - computed on demand, nothing leaves the device.
  | { type: "history:stats" }
  // Export dumps the account's history as portable rows for a local JSON
  // download; import REPLACES the account's history with the file's rows
  // (deduped within the file, re-homed to the importing account).
  | { type: "history:export" }
  | { type: "history:import"; rows: PortableHistoryRow[] }
  | { type: "auth:status" }
  | { type: "auth:openTab" }
  | { type: "auth:signOut" }
  | { type: "auth:delete" }
  // The email-code sign-in exchange, sent by the extension's auth page and by
  // nothing else. It runs in the service worker rather than on the page so the
  // session token `verify` mints is written where it is used - it never travels
  // back over this channel (see the auth:otpVerified response, which has no
  // token field, and the router handler that drops it).
  | { type: "auth:requestOtp"; email: string }
  | { type: "auth:verifyOtp"; email: string; code: string }
  | { type: "ui:injected"; targetCount: number };

// What the user did to produce a history row, so the popup can tint it.
// Optional on rows stored before this field existed (rendered untinted).
export type ReactionAction = "add" | "remove" | "change";

export type ReactionHistoryItem = {
  // Device-local IndexedDB row id - insertion order, and the paging cursor.
  id?: number;
  // Local-only id used to roll back an optimistic history row.
  historyId?: string;
  userId: string;
  target: TargetRef;
  reaction: Reaction;
  ts: number;
  action?: ReactionAction;
  // Page title at click time (device-local; the History list shows it under the
  // URL). Absent on rows recorded before titles were captured.
  title?: string;
};

// The portable subset of a history row used by export/import. Shaped like the
// vote payload (`{ site, targetId, targetUrl, reaction, ts }`) rather than the
// nested runtime `target`. Device-local ids and the owning `userId` are
// dropped - import re-homes rows to the current account. `targetId` stays: it
// is the canonical key (`site:targetId`), derived by the site adapters and not
// re-derivable from the URL in the background.
export interface PortableHistoryRow {
  site: SupportedSite;
  targetId: string;
  targetUrl: string;
  reaction: Reaction;
  ts: number;
  action?: ReactionAction;
}

// Schema version of the export file - bumped only when the file/row shape
// changes, independent of the extension release version (in `app.version`).
export const HISTORY_EXPORT_SCHEMA_VERSION = 1;

// The JSON shape of the download file. `format` is a magic marker so an import
// can reject unrelated JSON before touching stored history; `app` is
// informational provenance. Deliberately no device/browser fields: the file is
// meant to be moved between machines and shared for support, so it must not
// carry a fingerprint the restore path never reads.
export interface HistoryExportFile {
  format: "emojery-history";
  schemaVersion: number;
  exportedAt: string;
  app: { name: string; version: string };
  reactions: PortableHistoryRow[];
}

// Device-local aggregates over one account's whole reaction history. `total`
// is every history row; `byEmoji`/`bySite` are the full per-key distributions
// for the History-tab facet chips.
export interface HistoryStats {
  total: number;
  byEmoji: Record<string, number>;
  bySite: Record<string, number>;
}

export const EMPTY_HISTORY_STATS: HistoryStats = {
  total: 0,
  byEmoji: {},
  bySite: {},
};

// Failure class a caller can switch on. The paired `message` is a fixed,
// credential-free string for developers - never render it, localize from `code`.
export type RuntimeErrorCode =
  // The request never reached the API (offline, blocked, aborted).
  | "network"
  // The API asked us to slow down (429).
  | "rate_limited"
  // The API answered but failed (5xx).
  | "server"
  // Anything else the background could not complete (storage, IndexedDB, an
  // unexpected 4xx) - the generic "try again" bucket.
  | "unavailable";

export type RuntimeResponse =
  | { type: "ok" }
  | { type: "count"; data: TargetCounts }
  | { type: "history:page"; items: ReactionHistoryItem[]; cursor: number | null; authed: boolean }
  | { type: "history:stats"; stats: HistoryStats; authed: boolean }
  | { type: "history:export"; rows: PortableHistoryRow[]; authed: boolean }
  // Import replaces the account's whole history with the file's rows; `imported`
  // is how many were written, `replaced` how many were wiped first.
  | { type: "history:import"; imported: number; replaced: number; authed: boolean }
  | {
      type: "auth:status";
      authed: boolean;
      userId: string | null;
      email: string | null;
    }
  // `status` is the API's own HTTP status, which the auth page maps to its copy
  // (429 cooldown, 502 undeliverable, 423 locked out, ...); `error` is the API's
  // machine string, rendered only as the last-resort fallback. Neither carries
  // the minted session - see the auth:verifyOtp note above.
  | { type: "auth:otpRequested"; ok: boolean; status: number; error?: string; retryAfterSeconds?: number }
  | { type: "auth:otpVerified"; ok: boolean; status: number; error?: string }
  | { type: "error"; code: RuntimeErrorCode; message: string };

export type VoteBroadcast = {
  target: TargetRef;
  reaction: Reaction | null;
  prevReaction: Reaction | null;
};

export type VoteSyncMessage = { type: "voteSync" } & VoteBroadcast;
