// SPDX-License-Identifier: GPL-3.0-or-later
//
// The dev/staging console channel, shared by the background and the content script.
// Lives in shared/ because the content script must NOT reach background/debug.ts: that
// module also owns `apiFetch`, and importing it would pull the fetch-deadline machinery
// into every content bundle. Nothing checks that import edge directly - the content-script
// weight budget is the only thing that would eventually notice.
//
// Everything here folds to dead code in a production build - see DEBUG_LOG_ENABLED.

// Injected by wxt.config.ts: false in a production build, so every channel below
// folds to dead code and drops out of the shipped bundle. Undefined under Vitest,
// where the debug suites exercise the logging path directly - hence the `||`
// default-on, the same shape shared/i18n.ts uses for its own build-time constant.
declare const __EM_DEBUG_LOG__: boolean;
export const DEBUG_LOG_ENABLED: boolean = typeof __EM_DEBUG_LOG__ === "undefined" || __EM_DEBUG_LOG__;

// Dev logging redacts credential-like fields before writing to the console. Matched
// by case-insensitive key substring so `access_token`, `refresh_token`, `otp` and
// `api_key` are caught too; over-redacting in a dev-only log is harmless, leaking is not.
const SENSITIVE_KEY_FRAGMENTS = ["auth", "jwt", "password", "secret", "token", "email", "code", "session", "otp", "bearer", "key"];
// Redact any value shaped like a JWT (three base64url segments) or a
// `Bearer <token>` header, regardless of the key it sits under.
const SENSITIVE_VALUE_RE = /^(?:bearer\s+)?ey[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+$/i;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEY_FRAGMENTS.some((fragment) => lower.includes(fragment));
}

export function redactSensitive(value: unknown): unknown {
  if (typeof value === "string") return SENSITIVE_VALUE_RE.test(value.trim()) ? "[redacted]" : value;
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      out[key] = "[redacted]";
    } else {
      out[key] = redactSensitive(raw);
    }
  }
  return out;
}

// Not exported: every caller passes a literal, and the two entry points below are
// the whole public surface.
type DebugChannel = "api" | "indexeddb" | "error" | "content";

// The console method each channel speaks through. `error` has to be `console.error`:
// a developer narrowing DevTools to Errors/Warnings - the first move when something
// misbehaves - is exactly the person these traces exist for, and at `info` they are
// invisible to that filter. The rest stay `info` so a normal run is not a wall of red.
const CONSOLE_METHOD: Record<DebugChannel, "info" | "error"> = {
  api: "info",
  indexeddb: "info",
  content: "info",
  error: "error",
};

export function logDebug(channel: DebugChannel, payload: unknown): void {
  try {
    // `channel` is a literal union, so nothing user-supplied reaches the format string. Accepted 2026-08-25.
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring
    console[CONSOLE_METHOD[channel]](`[emojery:${channel}]`, payload);
  } catch {
    // Debug logging must never affect extension behavior.
  }
}

/** Trace for a failure the caller deliberately absorbs (best-effort background work, a
 *  fire-and-forget task). Silent absorption is how a stalled queue - or a mount that
 *  never appears - hides. Dev/staging only, so a shipped build stays quiet.
 *
 *  Callers name the channel they belong to: `logBackgroundError` (background/debug.ts)
 *  and `logContentError` (ui/debug.ts) are the two entry points, so a console line says
 *  which side produced it without reading the scope. */
export function logScopedError(channel: DebugChannel, scope: string, error: unknown): void {
  if (!DEBUG_LOG_ENABLED) return;
  logDebug(channel, {
    scope,
    message: redactSensitive(error instanceof Error ? error.message : String(error)),
  });
}
