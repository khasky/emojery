// SPDX-License-Identifier: GPL-3.0-or-later

import { API_TIMEOUT_MS } from "../shared/config";
import { DEBUG_LOG_ENABLED, logDebug, logScopedError, redactSensitive } from "../shared/debug-log";
import { deadlineSignal } from "../shared/fetch-deadline";

// Every API request carries a deadline: no `signal` means "hang forever", and a hung read
// keeps its slot in api-read's in-flight map until the service worker restarts. A caller
// that passes its own signal keeps it - the deadline only fills a gap.
function applyTimeout(init?: RequestInit): RequestInit {
  if (init?.signal) return init;
  const signal = deadlineSignal(API_TIMEOUT_MS);
  return signal ? { ...(init ?? {}), signal } : (init ?? {});
}

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const withDeadline = applyTimeout(init);
  if (!DEBUG_LOG_ENABLED) return fetch(input, withDeadline);

  const startedAt = Date.now();
  const requestPayload = buildRequestPayload(input, init);
  try {
    const response = await fetch(input, withDeadline);
    const responsePayload = await readResponsePayload(response).catch((error: unknown) => ({
      error: error instanceof Error ? error.message : String(error),
    }));
    logDebug("api", {
      statusCode: response.status,
      responsePayload: redactSensitive(responsePayload),
      requestPayload,
      execTime: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    logDebug("api", {
      statusCode: 0,
      // Redacted like the success path above: a rejection message carries no credential
      // today, but the two arms must not diverge on that - the one that does is the one
      // that leaks the day a fetch failure starts echoing the request.
      responsePayload: redactSensitive({
        error: error instanceof Error ? error.message : String(error),
      }),
      requestPayload,
      execTime: Date.now() - startedAt,
    });
    throw error;
  }
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

function buildRequestPayload(input: RequestInfo | URL, init?: RequestInit): Record<string, unknown> {
  const url = requestUrl(input);
  const body = init?.body;
  const payload: Record<string, unknown> = {
    method: init?.method ?? (isRequest(input) ? input.method : "GET"),
    // Path only: the query goes into `payload.query` below, where redactSensitive
    // strips it by key. Keeping the raw query on the URL string too would log it a
    // second time past that redaction, so a value in a query parameter is dropped here.
    url: urlPathForLog(url),
  };
  const query = queryPayload(url);
  if (Object.keys(query).length > 0) payload.query = query;
  const parsedBody = parseBody(body);
  if (parsedBody !== undefined) payload.body = parsedBody;
  return redactSensitive(payload) as Record<string, unknown>;
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (isUrl(input)) return input.toString();
  return input.url;
}

// The URL without its query string, for the log's `url` field. The query is logged
// separately (queryPayload), where redactSensitive can strip a value by key; leaving it
// on the URL string would sidestep that. Falls back to the raw string if it will not parse.
function urlPathForLog(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url;
  }
}

function isUrl(input: RequestInfo | URL): input is URL {
  return typeof URL !== "undefined" && input instanceof URL;
}

function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== "undefined" && input instanceof Request;
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

async function readResponsePayload(response: Response): Promise<unknown> {
  const clone = response.clone();
  if (response.status === 204 || response.status === 205) return null;
  const text = await clone.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
