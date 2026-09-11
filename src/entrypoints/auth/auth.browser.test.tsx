// SPDX-License-Identifier: GPL-3.0-or-later
//
// The auth page's client-side state machine: what each API status turns into on
// screen, the cooldown that survives a reload, and the pre-140 Firefox consent
// gate. e2e/auth.spec.ts drives the real sign-in end to end; this file covers
// the UI states against a mocked background.
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AUTH_ERROR_ID, AUTH_ERROR_SELECTOR, CODE_INPUT_SELECTOR, COUNTDOWN_SELECTOR, EMAIL_INPUT_SELECTOR, NOTICE_SELECTOR, TAGLINE_SELECTOR } from "../../shared/page-dom";
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
// The one line every refused address gets on a 422, whichever refusal the API named.
const UNREACHABLE_COPY = "That email domain can't receive mail. Check the address for a typo, or try another one.";
// In production the background closes this tab on an "ok", so nothing repaints
// after it - here the page simply stays put, which is what the asserts read.
const OK_RETURN = { type: "ok" };

let shim: ChromeShimHandle;
let sent: unknown[];
/** Cache-buster: the module registry hands back the same instance however often it is asked. */
let loads = 0;

function install({ requestReply = OK_REQUEST, verifyReply = OK_VERIFY, returnReply = OK_RETURN }: { requestReply?: unknown; verifyReply?: unknown; returnReply?: unknown } = {}): void {
  sent = [];
  shim = installChromeShim({
    onMessage: (msg) => {
      sent.push(msg);
      const type = (msg as { type?: string }).type;
      if (type === "auth:requestOtp") return requestReply;
      if (type === "auth:verifyOtp") return verifyReply;
      if (type === "auth:returnToOrigin") return returnReply;
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
const emailField = () => requireEl<HTMLInputElement>(document, EMAIL_INPUT_SELECTOR);
const codeField = () => requireEl<HTMLInputElement>(document, CODE_INPUT_SELECTOR);
const termsBox = () => requireEl<HTMLInputElement>(document, ".agree input[type=checkbox]");
const primaryBtn = () => requireEl<HTMLButtonElement>(document, "button.primary");
const errorText = (): string => document.querySelector(AUTH_ERROR_SELECTOR)?.textContent ?? "";
const linkish = (label: string): HTMLButtonElement | undefined => [...document.querySelectorAll<HTMLButtonElement>("button.linkish")].find((b) => b.textContent?.includes(label));

/** Email step -> a sent request. Leaves the page wherever that request took it. */
async function sendCode(address = EMAIL): Promise<void> {
  await userEvent.fill(emailField(), address);
  await userEvent.click(termsBox());
  await userEvent.click(primaryBtn());
}

async function reachCodeStep(): Promise<void> {
  await sendCode();
  await vi.waitFor(() => expect(document.querySelector(CODE_INPUT_SELECTOR)).not.toBeNull());
}

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  history.replaceState({}, "", PAGE_URL);
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  // Unmount, don't just wipe the markup: the page's own timers (the resend
  // countdown, the return countdown) live in effect cleanups, and a torn-down
  // <body> leaves them running - a leaked return then messaged the NEXT test's shim.
  const app = document.getElementById("app");
  if (app) render(null, app);
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
    await vi.waitFor(() => expect(document.title).toBe("Emojery — Enter your code"));
    expect(document.querySelector(TAGLINE_SELECTOR)?.textContent).toContain(EMAIL);
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
    expect(document.querySelector(CODE_INPUT_SELECTOR)).toBeNull();
    // rateLimit shows no countdown - a 429 window is the server's, not the 30s resend one.
    expect(document.querySelector(NOTICE_SELECTOR)).toBeNull();
    const cooldown = storedCooldown();
    expect(cooldown?.reason).toBe("rateLimit");
    expect((cooldown?.until ?? 0) - Date.now()).toBeGreaterThan(60_000);
  });

  it.each([
    [502, "Could not deliver the email. Try again or check the address."],
    [422, UNREACHABLE_COPY],
    [400, "That doesn't look like a valid email address."],
  ])("renders the %i copy and stays on the email step", async (status, copy) => {
    install({ requestReply: { type: "auth:otpRequested", ok: false, status } });
    await loadPage();
    await sendCode();

    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe(copy);
    expect(document.querySelector(CODE_INPUT_SELECTOR)).toBeNull();
    // A failed send arms nothing: the user may retry immediately.
    expect(storedCooldown()).toBeNull();
  });

  // `error` is a diagnostic for the background's message log, never UI copy. Two
  // properties in one: it is not rendered, and it does not SELECT what is rendered
  // either - the copy for a status is the same whatever string rides along, so a
  // refusal cannot be told apart by reading the screen. One exception below.
  it.each([
    [500, "Something went wrong. Please try again."],
    [422, UNREACHABLE_COPY],
    [403, "Something went wrong. Please try again."],
  ])("renders the %i copy whatever the machine error string says", async (status, copy) => {
    install({ requestReply: { type: "auth:otpRequested", ok: false, status, error: "unsupported_client" } });
    await loadPage();
    await sendCode();
    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe(copy);
    expect(document.body.textContent).not.toContain("unsupported_client");
  });

  // The exception: a build the API no longer serves. The fix is on the user's side,
  // so the copy says update rather than try again.
  it("asks for an update when the API refuses this build", async () => {
    install({ requestReply: { type: "auth:otpRequested", ok: false, status: 403, error: "client_outdated" } });
    await loadPage();
    await sendCode();
    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe("This version of Emojery is out of date. Update it to sign in.");
    expect(document.querySelector(CODE_INPUT_SELECTOR)).toBeNull();
  });

  it("treats a background that answers something else as a network error", async () => {
    // Anything but an auth:otpRequested envelope is askOtp's OTP_UNREACHABLE marker.
    install({ requestReply: { type: "error", code: "unavailable" } });
    await loadPage();
    await sendCode();

    await vi.waitFor(() => expect(errorText()).not.toBe(""));
    expect(errorText()).toBe("Something went wrong. Please try again.");
    expect(document.querySelector(CODE_INPUT_SELECTOR)).toBeNull();
  });

  it("re-arms from a cooldown another tab wrote instead of sending again", async () => {
    install();
    await loadPage();
    await userEvent.fill(emailField(), EMAIL);
    await userEvent.click(termsBox());
    // Same profile, second tab: the window opened after this page rendered.
    seedCooldown({ until: Date.now() + 30_000, reason: "resend", email: EMAIL });
    await userEvent.click(primaryBtn());

    await vi.waitFor(() => expect(document.querySelector(NOTICE_SELECTOR)).not.toBeNull());
    expect(sent.some((m) => (m as { type?: string }).type === "auth:requestOtp")).toBe(false);
    expect(document.querySelector(NOTICE_SELECTOR)?.textContent).toContain("We already sent a code to this address");
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
    expect(document.querySelector(TAGLINE_SELECTOR)?.textContent).toContain(pending);
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
    expect(codeField().getAttribute("aria-describedby")).toBe(AUTH_ERROR_ID);
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
    await vi.waitFor(() => expect(document.title).toBe("Emojery — You're signed in"));
    expect(sent.filter((m) => (m as { type?: string }).type === "auth:verifyOtp")).toEqual([{ type: "auth:verifyOtp", email: EMAIL, code: "123456" }]);
    // No page to go back to: the dead-end copy, and nothing that could close a tab.
    expect(document.querySelector(COUNTDOWN_SELECTOR)).toBeNull();
    expect(sent.some((m) => (m as { type?: string }).type === "auth:returnToOrigin")).toBe(false);
  });

  describe("the return to the page the sign-in started from", () => {
    async function verifyWithReturn(): Promise<void> {
      install({ verifyReply: { ...OK_VERIFY, returnsToPage: true } });
      await loadPage();
      await reachCodeStep();
      await userEvent.fill(codeField(), "123456");
      await userEvent.click(primaryBtn());
      await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
    }

    it("counts down, then asks the background to take the user back", async () => {
      await verifyWithReturn();

      expect(requireEl(document, TAGLINE_SELECTOR).textContent).toBe("Taking you back to the page you were on.");
      // The seconds and the draining bar are decoration over the sentence above -
      // a screen reader gets the sentence once, not a tick per second.
      expect(requireEl(document, COUNTDOWN_SELECTOR).getAttribute("aria-hidden")).toBe("true");
      expect(requireEl(document, `${COUNTDOWN_SELECTOR} .seconds`).textContent).toBe("5");
      // The primary action holds focus, since the Verify button it replaced is gone.
      await vi.waitFor(() => expect((document.activeElement as HTMLElement | null)?.className).toBe("primary"));
      // Going back is the only control the step offers - the tab closes itself,
      // and closing it by hand is how a user stays put.
      expect(document.querySelectorAll("#app button")).toHaveLength(1);
    });

    it("fires the return by itself once the countdown runs out", async () => {
      await verifyWithReturn();

      await vi.waitFor(() => expect(sent.some((m) => (m as { type?: string }).type === "auth:returnToOrigin")).toBe(true), { timeout: 12_000 });
    }, 20_000);

    it("goes back at once when asked, without waiting out the countdown", async () => {
      await verifyWithReturn();
      await userEvent.click(primaryBtn());

      expect(sent.filter((m) => (m as { type?: string }).type === "auth:returnToOrigin")).toHaveLength(1);
    });

    it("falls back to the dead-end copy when the origin tab went away mid-countdown", async () => {
      install({ verifyReply: { ...OK_VERIFY, returnsToPage: true }, returnReply: { type: "error", code: "unavailable", message: "gone" } });
      await loadPage();
      await reachCodeStep();
      await userEvent.fill(codeField(), "123456");
      await userEvent.click(primaryBtn());
      await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
      await userEvent.click(primaryBtn());

      await vi.waitFor(() => expect(document.querySelector(COUNTDOWN_SELECTOR)).toBeNull());
      expect(requireEl(document, TAGLINE_SELECTOR).textContent).toBe("You can close this tab and react on any supported page.");
    });
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
    expect(document.title).toBe("What Emojery sends");
    expect(document.querySelector(EMAIL_INPUT_SELECTOR)).toBeNull();

    // The policy closes the disclosure paragraph as its last sentence - it was a
    // block of its own, which read as a second button beside Continue.
    const body = requireEl(document, "#app .tagline");
    expect(body.querySelector("a")?.textContent).toBe("Privacy Policy.");
    expect(document.querySelector("#app .notice")).toBeNull();

    await userEvent.click(primaryBtn());
    expect(heading()).toBe("Sign in to react");
    // The consent title is the gate's alone: the sign-in form brings its own.
    await vi.waitFor(() => expect(document.title).toBe("Emojery — Sign in"));
  });

  it("goes straight to sign-in without the flag", async () => {
    install();
    await loadPage();
    expect(heading()).toBe("Sign in to react");
  });
});
