// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getOtpCooldown, OTP_COOLDOWN_KEY as KEY, normalizeCooldownEmail, setOtpCooldown } from "./otp-cooldown";

// Frozen clock so the `until` math is exact equalities, not +/-50ms fudge.
const FROZEN_NOW = Date.UTC(2026, 0, 1);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now: FROZEN_NOW });
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("otp-cooldown", () => {
  it("returns null when no cooldown is stored", () => {
    expect(getOtpCooldown()).toBeNull();
  });

  it("persists and reads back an active cooldown with reason and email", () => {
    const cd = setOtpCooldown("a@b.com", 60, "resend");
    expect(cd.reason).toBe("resend");
    expect(cd.email).toBe("a@b.com");
    expect(cd.until).toBe(FROZEN_NOW + 60_000);
    expect(getOtpCooldown()).toEqual(cd);
  });

  it("preserves the rateLimit reason", () => {
    setOtpCooldown("a@b.com", 30, "rateLimit");
    expect(getOtpCooldown()?.reason).toBe("rateLimit");
  });

  it("is global: a later send for a different address overwrites the record", () => {
    setOtpCooldown("alice@example.com", 60, "resend");
    const second = setOtpCooldown("bob@example.com", 60, "resend");
    expect(getOtpCooldown()).toEqual(second);
    expect(getOtpCooldown()?.email).toBe("bob@example.com");
  });

  it("stores the normalized (trim + lowercase) address", () => {
    const cd = setOtpCooldown("  Alice@Example.COM ", 30, "resend");
    expect(cd.email).toBe("alice@example.com");
    expect(normalizeCooldownEmail("  Alice@Example.COM ")).toBe("alice@example.com");
  });

  it("prunes an expired entry and returns null", () => {
    localStorage.setItem(KEY, JSON.stringify({ until: Date.now() - 1000, reason: "resend", email: "a@b.com" }));
    expect(getOtpCooldown()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("ignores a malformed (non-JSON) stored value", () => {
    localStorage.setItem(KEY, "not-json");
    expect(getOtpCooldown()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("ignores an entry with an unknown reason", () => {
    localStorage.setItem(KEY, JSON.stringify({ until: Date.now() + 60_000, reason: "bogus", email: "a@b.com" }));
    expect(getOtpCooldown()).toBeNull();
  });

  it("ignores an entry missing the email field", () => {
    localStorage.setItem(KEY, JSON.stringify({ until: Date.now() + 60_000, reason: "resend" }));
    expect(getOtpCooldown()).toBeNull();
  });

  it("clamps a sub-second cooldown up to at least 1 second", () => {
    const cd = setOtpCooldown("a@b.com", 0, "resend");
    expect(cd.until).toBe(FROZEN_NOW + 1_000);
  });

  it("clamps an absurd cooldown down to the one-hour max", () => {
    const cd = setOtpCooldown("a@b.com", 10 * 60 * 60, "rateLimit");
    expect(cd.until).toBe(FROZEN_NOW + 60 * 60 * 1000);
  });
});
