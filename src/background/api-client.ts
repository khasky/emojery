// SPDX-License-Identifier: GPL-3.0-or-later
//
// The one way the background talks to the API. A call names a path and what it
// sends; everything the wire needs on top - the client identity headers, the
// install id, the deadline, `Retry-After`, the JSON body read - happens here, so
// no caller assembles a request or casts a response.
//
// Two header shapes the client sends: a POST carries the JSON headers
// (content-type, the install id, accept-language when a language is given); a
// GET carries only the client identity headers. A bearer token rides on either.

import { markClientOutdated } from "../shared/client-outdated";
import { API_BASE, API_TIMEOUT_MS } from "../shared/config";
import { deadlineSignal } from "../shared/fetch-deadline";
import { normalizeLanguageTag } from "../shared/language-tag";
import type { RuntimeErrorCode } from "../shared/messages";
import { logApiExchange, logBackgroundError } from "./debug";

export interface ApiRequestOptions {
  method: "GET" | "POST";
  /** Bearer token for an authed call. */
  token?: string;
  /** BCP-47 tag for `accept-language`; only a POST carries it (see the header shapes above). */
  lang?: string | undefined;
  /** JSON-encoded as the request body. */
  body?: unknown;
  keepalive?: boolean;
  cache?: RequestCache;
  /** A caller-owned deadline (one signal shared by a retry pair); absent, the request gets API_TIMEOUT_MS. */
  signal?: AbortSignal;
}

export interface ApiReply {
  ok: boolean;
  status: number;
  /** Parsed `Retry-After`, in seconds; absent when the header is missing or malformed. */
  retryAfterSeconds?: number;
  /** The JSON body; `null` for an empty or non-JSON one. */
  body: unknown;
}

export async function apiRequest(path: string, options: ApiRequestOptions): Promise<ApiReply> {
  const url = `${API_BASE}${path}`;
  const headers = options.method === "POST" ? jsonHeaders(options) : clientHeaders(options);
  const init: RequestInit = {
    method: options.method,
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    ...(options.keepalive ? { keepalive: true } : {}),
    ...(options.cache ? { cache: options.cache } : {}),
  };
  // No `signal` means "hang forever", and a hung read keeps its slot in api-read's
  // in-flight map until the service worker restarts.
  const signal = options.signal ?? deadlineSignal(API_TIMEOUT_MS);
  if (signal) init.signal = signal;

  const startedAt = Date.now();
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    logApiExchange(url, init, { error }, startedAt);
    throw error;
  }
  const retryAfterSeconds = parseRetryAfterSeconds(response.headers.get("retry-after"));
  const text = await response.text();
  let body: unknown = null;
  let loggedBody: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
      loggedBody = body;
    } catch (error) {
      loggedBody = text;
      // A 2xx the client cannot read is a server-contract break worth a trace; a
      // failure body is free-form and reads as `null` to the caller.
      if (response.ok) logBackgroundError("apiRequest.parseBody", error);
    }
  }
  logApiExchange(url, init, { status: response.status, body: loggedBody }, startedAt);
  // The API retired this build (shared/client-outdated.ts): any route may say so.
  if (response.status === 410 && apiErrorString(body) === "client_outdated") await markClientOutdated().catch((error: unknown) => logBackgroundError("apiRequest.markClientOutdated", error));
  return {
    ok: response.ok,
    status: response.status,
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
    body,
  };
}

// A non-ok API response. Carries the status so callers classify the failure from
// a field instead of re-parsing a message string.
export class ApiHttpError extends Error {
  constructor(readonly status: number) {
    super(`http ${status}`);
    this.name = "ApiHttpError";
  }
}

export function apiErrorCode(error: unknown): RuntimeErrorCode {
  if (!(error instanceof ApiHttpError)) return "network";
  if (error.status === 429) return "rate_limited";
  return error.status >= 500 ? "server" : "unavailable";
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `error` string a refused request answers with, when the body carries one. */
export function apiErrorString(body: unknown): string | undefined {
  return isRecord(body) && typeof body.error === "string" && body.error ? body.error : undefined;
}

// The UI language a request carries, as `accept-language` and as the auth
// endpoints' `lang` body field. Held to a well-formed BCP-47 tag by
// normalizeLanguageTag, the same validator the vote path applies to a page's
// language, so region survives (`pt-BR` stays `pt-BR`) and only a malformed
// value is dropped.
export function requestLanguage(): string | undefined {
  return normalizeLanguageTag(typeof navigator !== "undefined" ? navigator.language : undefined);
}

/** Parse `Retry-After` as delta-seconds or HTTP-date. */
function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  const date = Date.parse(value);
  if (Number.isFinite(date)) {
    return Math.max(0, Math.floor((date - Date.now()) / 1000));
  }
  return undefined;
}

// No two sources share a header name, so spread order never changes the result.
function jsonHeaders(options: ApiRequestOptions): Record<string, string> {
  return {
    "content-type": "application/json",
    ...clientHeaders(options),
    ...(options.lang ? { "accept-language": options.lang } : {}),
  };
}

// Client identity headers. Not secrets.
function clientHeaders(options: ApiRequestOptions): Record<string, string> {
  const manifest = globalThis.chrome?.runtime?.getManifest?.();
  return {
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    "x-emojery-client": "extension",
    "x-emojery-client-version": manifest?.version ?? "0.0.0",
  };
}
