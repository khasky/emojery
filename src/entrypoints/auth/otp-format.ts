// SPDX-License-Identifier: GPL-3.0-or-later
//
// Pure validation/formatting helpers for the auth page, kept out of main.tsx
// (which renders at import time) so they are unit-testable.

import { normalizeCooldownEmail, type OtpCooldown } from "./otp-cooldown";

export const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function formatCountdown(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

// Benign-resend-window message only (the 429 case renders a separate time-free line).
// "This address" while the field still holds the address the code went to, else a generic throttle.
export function cooldownMessageKey(cooldown: OtpCooldown | null, email: string) {
  if (cooldown && normalizeCooldownEmail(email) === cooldown.email) {
    return "authResendCooldown" as const;
  }
  return "authSendThrottle" as const;
}
