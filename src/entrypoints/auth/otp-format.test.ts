// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import type { OtpCooldown } from "./otp-cooldown";
import { cooldownMessageKey, EMAIL_SHAPE, formatCountdown } from "./otp-format";

describe("EMAIL_SHAPE", () => {
  it("accepts normal addresses", () => {
    expect(EMAIL_SHAPE.test("user@example.com")).toBe(true);
    expect(EMAIL_SHAPE.test("first.last+tag@sub.domain.co")).toBe(true);
  });

  it("rejects junk", () => {
    expect(EMAIL_SHAPE.test("")).toBe(false);
    expect(EMAIL_SHAPE.test("plainaddress")).toBe(false);
    expect(EMAIL_SHAPE.test("a b@example.com")).toBe(false);
    expect(EMAIL_SHAPE.test("a@b@example.com")).toBe(false);
    expect(EMAIL_SHAPE.test("@example.com")).toBe(false);
    expect(EMAIL_SHAPE.test("user@example")).toBe(false);
  });
});

describe("formatCountdown", () => {
  it("formats m:ss with zero-padded seconds", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(59)).toBe("0:59");
    expect(formatCountdown(60)).toBe("1:00");
    expect(formatCountdown(90)).toBe("1:30");
    expect(formatCountdown(3599)).toBe("59:59");
    expect(formatCountdown(3600)).toBe("60:00");
  });
});

describe("cooldownMessageKey", () => {
  const cooldown: OtpCooldown = { until: Date.now() + 30_000, reason: "resend", email: "a@b.example" };

  it("names the same-address resend window when the field still holds that address", () => {
    expect(cooldownMessageKey(cooldown, "a@b.example")).toBe("authResendCooldown");
    // Comparison runs on the normalized (trim + lowercase) address.
    expect(cooldownMessageKey(cooldown, "  A@B.Example ")).toBe("authResendCooldown");
  });

  it("falls back to the generic throttle otherwise", () => {
    expect(cooldownMessageKey(null, "a@b.example")).toBe("authSendThrottle");
    expect(cooldownMessageKey(cooldown, "other@b.example")).toBe("authSendThrottle");
  });
});
