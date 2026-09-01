// SPDX-License-Identifier: GPL-3.0-or-later
//
// Client-side cooldown cache for the OTP "Send code" step.

export const OTP_COOLDOWN_KEY = "otp_cooldown_v1";

/** Why the button is on cooldown - selects which message the UI shows. */
type OtpCooldownReason = "resend" | "rateLimit";

export interface OtpCooldown {
  /** Epoch-ms at which the user may send again. */
  until: number;
  reason: OtpCooldownReason;
  /** Normalized (trim + lowercase) address the cooldown was created for. */
  email: string;
}

export const OTP_RESEND_COOLDOWN_SECONDS = 30;

/** Fallback window used when a 429 response carries no usable retry hint. */
export const OTP_COOLDOWN_FALLBACK_SECONDS = 60;

/** Cap so a hostile or malformed duration can't lock the button for an absurd time. */
const OTP_COOLDOWN_MAX_SECONDS = 60 * 60;

export function normalizeCooldownEmail(email: string): string {
  return email.trim().toLowerCase();
}

function isReason(value: unknown): value is OtpCooldownReason {
  return value === "resend" || value === "rateLimit";
}

function removeQuietly(): void {
  try {
    localStorage.removeItem(OTP_COOLDOWN_KEY);
  } catch {
    /* storage unavailable - nothing to prune */
  }
}

/** Active cooldown or null; expired/malformed entries are pruned on read. Global - not keyed by email. */
export function getOtpCooldown(): OtpCooldown | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(OTP_COOLDOWN_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    removeQuietly();
    return null;
  }
  const rec = parsed as Partial<OtpCooldown>;
  if (!rec || typeof rec.until !== "number" || !Number.isFinite(rec.until) || !isReason(rec.reason) || typeof rec.email !== "string" || rec.until <= Date.now()) {
    removeQuietly();
    return null;
  }
  return { until: rec.until, reason: rec.reason, email: rec.email };
}

/** Persist a clamped cooldown and return it - returned even when storage is
 *  unavailable, so the in-session timer still works. */
export function setOtpCooldown(email: string, seconds: number, reason: OtpCooldownReason): OtpCooldown {
  const clamped = Math.min(OTP_COOLDOWN_MAX_SECONDS, Math.max(1, Math.ceil(seconds)));
  const cooldown: OtpCooldown = {
    until: Date.now() + clamped * 1000,
    reason,
    email: normalizeCooldownEmail(email),
  };
  try {
    localStorage.setItem(OTP_COOLDOWN_KEY, JSON.stringify(cooldown));
  } catch {
    /* storage unavailable - fall back to in-memory timer only */
  }
  return cooldown;
}
