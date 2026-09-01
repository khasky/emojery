// SPDX-License-Identifier: GPL-3.0-or-later
//
// The auth page's client-side state machine: what each API status turns into on
// screen, the cooldown that survives a reload, and the pre-140 Firefox consent
// gate. e2e/auth.spec.ts drives the real sign-in end to end; this file covers
// the UI states against a mocked background.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { requireEl } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim } from "../../test/chrome-shim";
import { OTP_COOLDOWN_KEY, type OtpCooldown } from "./otp-cooldown";

// CONSENT_ONLY is read off location.search at import, so the consent test rewrites
// the URL - restored verbatim between tests, because the runner's own query string
// is what later dynamic imports resolve against.
const PAGE_URL = location.href;
const EMAIL = "user@example.com";
const OK_REQUEST = { type: "auth:otpRequested", ok: true, status: 200 };
const OK_VERIFY = { type: "auth:otpVerified", ok: true, status: 200 };

let shim: ChromeShimHandle;
let sent: unknown[];
/** Cache-buster: the module registry hands back the same instance however often it is asked. */
let loads = 0;

function install({ requestReply = OK_REQUEST, verifyReply = OK_VERIFY }: { requestReply?: unknown; verifyReply?: unknown } = {}): void {
  sent = [];
  shim = installChromeShim({
    onMessage: (msg) => {
      sent.push(msg);
      const type = (msg as { type?: string }).type;
      if (type === "auth:requestOtp") return requestReply;
      if (type === "auth:verifyOtp") return verifyReply;
      return undefined;
    },
  });
}

function seedCooldown(cooldown: OtpCooldown): void {
  localStorage.setItem(OTP_COOLDOWN_KEY, JSON.stringify(cooldown));
}

function storedCooldown(): OtpCooldown | null {
  const raw = localStorage.getItem(OTP_COOLDOWN_KEY);
  return raw ? (JSON.parse(raw) as OtpCooldown) : null;
}

// main.tsx renders into #app at import time and reads `?consent=1` from the URL
// there too, so each test arranges the shim + the location and then imports fresh.
async function loadPage(): Promise<void> {
  loads += 1;
  await import(/* @vite-ignore */ `./main.tsx?load=${loads}`);
  await vi.waitFor(() => expect(document.querySelector("#app h1")).not.toBeNull());
}

const heading = (): string => requireEl(document, "#app h1").textContent ?? "";
const emailField = () => requireEl<HTMLInputElement>(document, "#email-input");
const codeField = () => requireEl<HTMLInputElement>(document, "#code-input");
const termsBox = () => requireEl<HTMLInputElement>(document, ".agree input[type=checkbox]");
const primaryBtn = () => requireEl<HTMLButtonElement>(document, "button.primary");
const errorText = (): string => document.querySelector(".error")?.textContent ?? "";
const linkish = (label: string): HTMLButtonElement | undefined => [...document.querySelectorAll<HTMLButtonElement>("button.linkish")].find((b) => b.textContent?.includes(label));

/** Email step -> a sent request. Leaves the page wherever that request took it. */
async function sendCode(address = EMAIL): Promise<void> {
  await userEvent.fill(emailField(), address);
  await userEvent.click(termsBox());
  await userEvent.click(primaryBtn());
}

async function reachCodeStep(): Promise<void> {
  await sendCode();
  await vi.waitFor(() => expect(document.querySelector("#code-input")).not.toBeNull());
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  history.replaceState({}, "", PAGE_URL);
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  document.body.innerHTML = "";
  shim.uninstall();
});

describe("auth page - the email step", () => {
  it("keeps Send disabled until the address parses AND the terms are ticked", async () => {
    install();
    await loadPage();

    expect(primaryBtn().disabled).toBe(true);
    await userEvent.fill(emailField(), "not-an-address");
    await userEvent.click(termsBox());
    expect(primaryBtn().disabled).toBe(true);

    await userEvent.fill(emailField(), EMAIL);
    expect(primaryBtn().disabled).toBe(false);
  });

  it("advances to the code step and arms the resend cooldown", async () => {
    install();
    await loadPage();
    await reachCodeStep();

    expect(heading()).toBe("Enter your code");
    expect(document.querySelector(".tagline")?.textContent).toContain(EMAIL);
    // The cooldown outlives the page (localStorage), so a reload cannot buy a second code.
    expect(storedCooldown()).toMatchObject({ reason: "resend", email: EMAIL });
    const resend = linkish("Resend code");
    expect(resend?.disabled).toBe(true);
    expect(resend?.textContent).toContain("Resend code in ");
  });

  it("holds a 429 on the email step with time-free copy, and stores the server's window", async () => {
    install({ requestReply: { type: "auth:otpRequested", ok: false, status: 429, retryAfterSeconds: 90 } });
    await loadPage();
    await sendCode();

    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe("Too many requests. Please wait a few minutes and try again.");
    expect(document.querySelector("#code-input")).toBeNull();
    // rateLimit shows no countdown - a 429 window is the server's, not the 30s resend one.
    expect(document.querySelector(".notice")).toBeNull();
    const cooldown = storedCooldown();
    expect(cooldown?.reason).toBe("rateLimit");
    expect((cooldown?.until ?? 0) - Date.now()).toBeGreaterThan(60_000);
  });

  it.each([
    [502, "Could not deliver the email. Try again or check the address."],
    [422, "Disposable / temporary email providers are not accepted. Please use a permanent address."],
    [400, "That doesn't look like a valid email address."],
  ])("maps a %i to its own copy and stays put", async (status, copy) => {
    install({ requestReply: { type: "auth:otpRequested", ok: false, status } });
    await loadPage();
    await sendCode();

    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe(copy);
    expect(document.querySelector("#code-input")).toBeNull();
    // A failed send arms nothing: the user may retry immediately.
    expect(storedCooldown()).toBeNull();
  });

  it("shows the API's own message when it sends one", async () => {
    install({ requestReply: { type: "auth:otpRequested", ok: false, status: 500, error: "backend on fire" } });
    await loadPage();
    await sendCode();
    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe("backend on fire");
  });

  it("treats a background that answers something else as a network error", async () => {
    // Anything but an auth:otpRequested envelope is askOtp's OTP_UNREACHABLE marker.
    install({ requestReply: { type: "error", code: "unavailable" } });
    await loadPage();
    await sendCode();

    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe("Something went wrong. Please try again.");
    expect(document.querySelector("#code-input")).toBeNull();
  });

  it("re-arms from a cooldown another tab wrote instead of sending again", async () => {
    install();
    await loadPage();
    await userEvent.fill(emailField(), EMAIL);
    await userEvent.click(termsBox());
    // Same profile, second tab: the window opened after this page rendered.
    seedCooldown({ until: Date.now() + 30_000, reason: "resend", email: EMAIL });
    await userEvent.click(primaryBtn());

    await vi.waitFor(() => expect(document.querySelector(".notice")).not.toBeNull());
    expect(sent.some((m) => (m as { type?: string }).type === "auth:requestOtp")).toBe(false);
    expect(document.querySelector(".notice")?.textContent).toContain("We already sent a code to this address");
  });

  it("keeps a one-click path back to a code that is still pending", async () => {
    const pending = "queued@example.com";
    seedCooldown({ until: Date.now() + 30_000, reason: "resend", email: pending });
    install();
    await loadPage();

    const back = await vi.waitFor(() => {
      const btn = linkish("Enter the code we sent to");
      expect(btn).toBeDefined();
      return btn as HTMLButtonElement;
    });
    expect(back.textContent).toContain(pending);
    await userEvent.click(back);

    expect(heading()).toBe("Enter your code");
    expect(document.querySelector(".tagline")?.textContent).toContain(pending);
  });
});

describe("auth page - the code step", () => {
  it.each([
    [401, "That code is incorrect or has expired."],
    [423, "Too many wrong codes. Try again later."],
  ])("maps a %i to its own copy and keeps the form", async (status, copy) => {
    install({ verifyReply: { type: "auth:otpVerified", ok: false, status } });
    await loadPage();
    await reachCodeStep();

    await userEvent.fill(codeField(), "123456");
    await userEvent.click(primaryBtn());

    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe(copy);
    expect(heading()).toBe("Enter your code");
    // aria wiring for the message the screen reader has to reach (WCAG 3.3.1).
    expect(codeField().getAttribute("aria-describedby")).toBe("auth-error");
    expect(codeField().getAttribute("aria-invalid")).toBe("true");
  });

  it("keeps Sign in disabled until the code is 6 digits, and drops non-digits", async () => {
    install();
    await loadPage();
    await reachCodeStep();

    expect(primaryBtn().disabled).toBe(true);
    // maxLength=6 clips the RAW input first, so the letter costs a digit - the
    // field ends up one short and the button stays disabled either way.
    await userEvent.fill(codeField(), "12a345");
    expect(codeField().value).toBe("12345");
    expect(primaryBtn().disabled).toBe(true);

    await userEvent.fill(codeField(), "123456");
    expect(primaryBtn().disabled).toBe(false);
  });

  it("confirms a verified code, sending the trimmed pair once", async () => {
    install();
    await loadPage();
    await reachCodeStep();
    await userEvent.fill(codeField(), "123456");
    await userEvent.click(primaryBtn());

    await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
    expect(sent.filter((m) => (m as { type?: string }).type === "auth:verifyOtp")).toEqual([{ type: "auth:verifyOtp", email: EMAIL, code: "123456" }]);
  });

  it("hands the field back for a different address", async () => {
    install();
    await loadPage();
    await reachCodeStep();

    const different = linkish("Use a different email");
    expect(different).toBeDefined();
    await userEvent.click(different as HTMLButtonElement);

    expect(heading()).toBe("Sign in to react");
    // The email field must accept typing again - it inherited the code input's
    // maxLength/pattern before the per-step keys landed (see main.tsx).
    await userEvent.fill(emailField(), "someone-else@example.com");
    expect(emailField().value).toBe("someone-else@example.com");
  });
});

describe("auth page - the legacy consent gate", () => {
  it("shows the disclosure first on ?consent=1, then the sign-in form", async () => {
    install();
    history.replaceState({}, "", `${PAGE_URL}${PAGE_URL.includes("?") ? "&" : "?"}consent=1`);
    await loadPage();

    expect(heading()).toBe("What Emojery sends");
    expect(document.querySelector("#email-input")).toBeNull();

    await userEvent.click(primaryBtn());
    expect(heading()).toBe("Sign in to react");
  });

  it("goes straight to sign-in without the flag", async () => {
    install();
    await loadPage();
    expect(heading()).toBe("Sign in to react");
  });
});
