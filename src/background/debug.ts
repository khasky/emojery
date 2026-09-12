// SPDX-License-Identifier: GPL-3.0-or-later
//
// The background's dev/staging console channels. Every function here folds to
// nothing in a shipped build (shared/debug-log DEBUG_LOG_ENABLED).

import { DEBUG_LOG_ENABLED, logDebug, logScopedError, redactSensitive } from "../shared/debug-log";

export type ApiExchangeOutcome = { status: number; body: unknown } | { error: unknown };

// One API round trip, as api-client.ts saw it: the request it sent and either the
// status + decoded body or the rejection. Credential-shaped fields are redacted
// on both arms - a rejection message carries no credential today, but the two
// must not diverge on that: the one that does is the one that leaks the day a
// fetch failure starts echoing the request.
export function logApiExchange(url: string, init: RequestInit, outcome: ApiExchangeOutcome, startedAt: number): void {
  if (!DEBUG_LOG_ENABLED) return;
  const responsePayload = "error" in outcome ? { error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error) } : outcome.body;
  logDebug("api", {
    statusCode: "error" in outcome ? 0 : outcome.status,
    responsePayload: redactSensitive(responsePayload),
    requestPayload: buildRequestPayload(url, init),
    execTime: Date.now() - startedAt,
  });
}

// Trace for a failure the caller deliberately absorbs (best-effort background
// work, a fire-and-forget task). Silent absorption is how a stalled queue hides;
// dev/staging-only, like every other channel here, so a shipped build stays quiet.
export function logBackgroundError(scope: string, error: unknown): void {
  logScopedError("error", scope, error);
}

export function logIndexedDbDebug(operation: string, requestPayload: Record<string, unknown>, responsePayload: unknown, startedAt: number): void {
  if (!DEBUG_LOG_ENABLED) return;
  logDebug("indexeddb", {
    operation,
    requestPayload: redactSensitive(requestPayload),
    responsePayload: redactSensitive(responsePayload),
    execTime: Date.now() - startedAt,
  });
}

function buildRequestPayload(url: string, init: RequestInit): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    method: init.method ?? "GET",
    // Path only: the query goes into `payload.query` below, where redactSensitive
    // strips it by key. Keeping the raw query on the URL string too would log it a
    // second time past that redaction, so a value in a query parameter is dropped here.
    url: urlPathForLog(url),
  };
  const query = queryPayload(url);
  if (Object.keys(query).length > 0) payload.query = query;
  const parsedBody = parseBody(init.body);
  if (parsedBody !== undefined) payload.body = parsedBody;
  return redactSensitive(payload) as Record<string, unknown>;
}

// The URL without its query string, for the log's `url` field. Falls back to the
// raw string if it will not parse.
function urlPathForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function queryPayload(url: string): Record<string, string | string[]> {
  try {
    const params = new URL(url).searchParams;
    const out: Record<string, string | string[]> = {};
    for (const [key, value] of params) {
      const existing = out[key];
      if (existing === undefined) {
        out[key] = value;
      } else if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        out[key] = [existing, value];
      }
    }
    return out;
  } catch {
    return {};
  }
}

// Request bodies, when present, are JSON strings; anything else only gets its
// shape logged, which is enough to spot it in a dev console.
function parseBody(body: BodyInit | null | undefined): unknown {
  if (body == null) return undefined;
  if (typeof body === "string") {
    if (!body) return "";
    try {
      return JSON.parse(body);
    } catch {
      return body;
    }
  }
  return { type: Object.prototype.toString.call(body) };
}
