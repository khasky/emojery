// SPDX-License-Identifier: GPL-3.0-or-later
//
// The auth page's client-side state machine: the provider list the API hands it,
// what each named refusal turns into on screen, and the pre-140 Firefox consent
// gate. e2e/auth.spec.ts drives the real sign-in end to end; this file covers
// the UI states against a mocked background.
import { render } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ACCOUNTS_SEEN_KEY } from "../../shared/account-names";
import { AGREE_CHECKBOX_SELECTOR, AUTH_ERROR_ID, AUTH_ERROR_SELECTOR, COUNTDOWN_SELECTOR, LAST_ACCOUNT_SELECTOR, MORE_PROVIDERS_SELECTOR, otherAccountSelector, PROVIDER_BUTTON_SELECTOR, PROVIDER_LIST_SELECTOR, providerButtonSelector, SPINNER_SELECTOR, TAGLINE_SELECTOR } from "../../shared/page-dom";
import { requireEl } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim } from "../../test/chrome-shim";

// CONSENT_ONLY is read off location.search at import, so the consent test rewrites
// the URL - restored unchanged between tests, because the runner's own query string
// is what later dynamic imports resolve against.
const PAGE_URL = location.href;
const PROVIDERS = { type: "auth:providers", providers: ["google", "apple", "microsoft", "twitch", "test"], chooser: ["google", "microsoft", "twitch", "test"] };
const OK_SIGN_IN = { type: "auth:signedIn", ok: true };
// In production the background closes this tab on an "ok", so nothing repaints
// after it - here the page stays put, which is what the asserts read.
const OK_RETURN = { type: "ok" };

let shim: ChromeShimHandle;
let sent: unknown[];
/** Cache-buster: the module registry hands back the same instance however often it is asked. */
let loads = 0;

// `signInReply` may be a promise, for the case that watches the page while the
// identity window is open.
function install({ providersReply = PROVIDERS, signInReply = OK_SIGN_IN, returnReply = OK_RETURN, closeReply = OK_RETURN }: { providersReply?: unknown; signInReply?: unknown; returnReply?: unknown; closeReply?: unknown } = {}): void {
  sent = [];
  shim = installChromeShim({
    onMessage: (msg) => {
      sent.push(msg);
      const type = (msg as { type?: string }).type;
      if (type === "auth:providers") return providersReply;
      if (type === "auth:signIn") return signInReply;
      if (type === "auth:returnToOrigin") return returnReply;
      if (type === "auth:closeTab") return closeReply;
      return undefined;
    },
  });
}

// main.tsx renders into #app at import time and reads `?consent=1` from the URL
// there too, so each test arranges the shim + the location and then imports fresh.
async function loadPage(): Promise<void> {
  loads += 1;
  await import(/* @vite-ignore */ `./main.tsx?load=${loads}`);
  await vi.waitFor(() => expect(document.querySelector("#app h1")).not.toBeNull());
}

const heading = (): string => requireEl(document, "#app h1").textContent ?? "";
const termsBox = () => requireEl<HTMLInputElement>(document, AGREE_CHECKBOX_SELECTOR);
const providerButtons = () => [...document.querySelectorAll<HTMLButtonElement>(PROVIDER_BUTTON_SELECTOR)];
const providerButton = (id: string) => requireEl<HTMLButtonElement>(document, providerButtonSelector(id));
const moreProvidersBtn = () => document.querySelector<HTMLButtonElement>(MORE_PROVIDERS_SELECTOR);
const primaryBtn = () => requireEl<HTMLButtonElement>(document, "button.primary");
const errorText = (): string => document.querySelector(AUTH_ERROR_SELECTOR)?.textContent ?? "";
const sentOfType = (type: string) => sent.filter((m) => (m as { type?: string }).type === type);

async function reachProviders(): Promise<void> {
  await vi.waitFor(() => expect(providerButtons().length).toBeGreaterThan(0));
}

/** Consent ticked, one provider picked. Leaves the page wherever the sign-in took it. */
async function pick(id = "google"): Promise<void> {
  await reachProviders();
  await userEvent.click(termsBox());
  const more = moreProvidersBtn();
  if (more && !document.querySelector(providerButtonSelector(id))) await userEvent.click(more);
  await userEvent.click(providerButton(id));
}

beforeEach(() => {
  vi.resetModules();
  history.replaceState({}, "", PAGE_URL);
  document.body.innerHTML = '<div id="app"></div>';
});

afterEach(() => {
  // Unmount, don't just wipe the markup: the page's own timers (the return
  // countdown) live in effect cleanups, and a torn-down <body> leaves them running -
  // a leaked return then messaged the NEXT test's shim.
  const app = document.getElementById("app");
  if (app) render(null, app);
  document.body.innerHTML = "";
  shim.uninstall();
  vi.useRealTimers();
});

describe("auth page - the provider step", () => {
  it("renders one button per provider the API lists, labelled by name, and hardcodes none", async () => {
    install();
    await loadPage();
    await reachProviders();

    expect(heading()).toBe("Sign in to react");
    await vi.waitFor(() => expect(document.title).toBe("Emojery — Sign in"));
    await userEvent.click(termsBox());
    await userEvent.click(requireEl<HTMLButtonElement>(document, MORE_PROVIDERS_SELECTOR));
    expect(providerButtons().map((b) => b.dataset.provider)).toEqual(["google", "apple", "microsoft", "twitch", "test"]);
    expect(providerButtons().map((b) => b.textContent?.trim())).toEqual(["Continue with Google", "Continue with Apple", "Continue with Microsoft", "Continue with Twitch", "Continue with test"]);
    expect(sentOfType("auth:providers")).toHaveLength(1);
  });

  it("names the account this device last used with a provider", async () => {
    // Written by a previous sign-in (background/identity.ts); the page reads it
    // locally, since the API tells it nothing about who signed in before.
    shim = installChromeShim({
      onMessage: (msg) => {
        sent.push(msg);
        return (msg as { type?: string }).type === "auth:providers" ? PROVIDERS : undefined;
      },
      local: { [ACCOUNTS_SEEN_KEY]: [{ provider: "google", userId: "u_1", at: 1_000 }] },
    });
    sent = [];
    await loadPage();
    await reachProviders();

    const google = providerButton("google");
    await vi.waitFor(() => expect(google.querySelector(LAST_ACCOUNT_SELECTOR)?.textContent).toMatch(/^Last time: [a-z]+-[a-z]+$/));
    // Nothing for a provider this device has not signed in with.
    expect(providerButton("apple").querySelector(LAST_ACCOUNT_SELECTOR)).toBeNull();
  });

  // Signing out ends our session, never the one the browser holds with the
  // provider, so the second account at one provider is reachable only from here.
  it("offers a second account where the provider can be asked for one, and asks for it on the click", async () => {
    shim = installChromeShim({
      onMessage: (msg) => {
        sent.push(msg);
        const type = (msg as { type?: string }).type;
        if (type === "auth:providers") return { ...PROVIDERS, chooser: ["google"] };
        return type === "auth:signIn" ? OK_SIGN_IN : undefined;
      },
      local: {
        [ACCOUNTS_SEEN_KEY]: [
          { provider: "google", userId: "u_1", at: 1_000 },
          { provider: "microsoft", userId: "u_2", at: 2_000 },
        ],
      },
    });
    sent = [];
    await loadPage();
    await reachProviders();
    await userEvent.click(termsBox());

    const other = await vi.waitFor(() => requireEl<HTMLButtonElement>(document, otherAccountSelector("google")));
    expect(other.textContent).toBe("Use a different Google account");
    // Microsoft was used on this device too, but the API says its picker cannot be
    // reopened - a control there would send a parameter the provider ignores.
    expect(document.querySelector(otherAccountSelector("microsoft"))).toBeNull();
    // And nothing to switch away from yet on a provider this device has not used.
    expect(document.querySelector(otherAccountSelector("apple"))).toBeNull();

    await userEvent.click(other);
    await vi.waitFor(() => expect(sentOfType("auth:signIn")).toHaveLength(1));
    expect(sentOfType("auth:signIn")[0]).toEqual({ type: "auth:signIn", provider: "google", chooser: true });
  });

  it("asks for no account picker on the ordinary provider button", async () => {
    install();
    await loadPage();
    await pick("google");

    await vi.waitFor(() => expect(sentOfType("auth:signIn")).toHaveLength(1));
    expect(sentOfType("auth:signIn")[0]).toEqual({ type: "auth:signIn", provider: "google" });
  });

  it("opens with the three most common accounts and keeps the rest behind one button", async () => {
    install();
    await loadPage();
    await reachProviders();

    expect(providerButtons().map((b) => b.dataset.provider)).toEqual(["google", "apple", "microsoft"]);
    const more = requireEl<HTMLButtonElement>(document, MORE_PROVIDERS_SELECTOR);
    expect(more.textContent?.trim()).toBe("More sign-in options");

    await userEvent.click(termsBox());
    await userEvent.click(more);

    expect(providerButtons().map((b) => b.dataset.provider)).toEqual(["google", "apple", "microsoft", "twitch", "test"]);
    // The button removed itself, so focus has to land on what it opened.
    expect(moreProvidersBtn()).toBeNull();
    await vi.waitFor(() => expect(document.activeElement).toBe(providerButton("twitch")));
  });

  it("offers the featured providers in a fixed order, whatever order the API used", async () => {
    install({ providersReply: { type: "auth:providers", providers: ["twitch", "microsoft", "google"] } });
    await loadPage();
    await reachProviders();

    expect(providerButtons().map((b) => b.dataset.provider)).toEqual(["google", "microsoft"]);
    await userEvent.click(termsBox());
    await userEvent.click(requireEl<HTMLButtonElement>(document, MORE_PROVIDERS_SELECTOR));
    expect(providerButtons().map((b) => b.dataset.provider)).toEqual(["google", "microsoft", "twitch"]);
  });

  it("shows no reveal button when the API lists nothing past the featured three", async () => {
    install({ providersReply: { type: "auth:providers", providers: ["google", "apple"] } });
    await loadPage();
    await reachProviders();

    expect(providerButtons().map((b) => b.dataset.provider)).toEqual(["google", "apple"]);
    expect(moreProvidersBtn()).toBeNull();
  });

  it("keeps every provider disabled until the terms are ticked", async () => {
    install();
    await loadPage();
    await reachProviders();

    expect(providerButtons().every((b) => b.disabled)).toBe(true);
    expect(moreProvidersBtn()?.disabled).toBe(true);
    await userEvent.click(termsBox());
    expect(providerButtons().every((b) => !b.disabled)).toBe(true);
    expect(moreProvidersBtn()?.disabled).toBe(false);
    expect(sentOfType("auth:signIn")).toHaveLength(0);
  });

  it("asks the background to sign in with the picked provider, and says so while it waits", async () => {
    let settle: (value: unknown) => void = () => {};
    install({ signInReply: new Promise((resolve) => (settle = resolve)) });
    await loadPage();
    await pick("apple");

    expect(sentOfType("auth:signIn")).toEqual([{ type: "auth:signIn", provider: "apple" }]);
    await vi.waitFor(() => expect(requireEl(document, TAGLINE_SELECTOR).textContent).toBe("Signing in with Apple..."));
    // Announced once, as the identity window opens - there is nothing to click here.
    expect(requireEl(document, TAGLINE_SELECTOR).getAttribute("role")).toBe("status");
    expect(document.querySelector(PROVIDER_LIST_SELECTOR)).toBeNull();

    // The wait can run for tens of seconds while the enrolment proof is built, so it
    // shows it is alive and guards the tab against a close that would strand it.
    expect(document.querySelector(SPINNER_SELECTOR)).not.toBeNull();

    settle(OK_SIGN_IN);
    await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
    await vi.waitFor(() => expect(document.title).toBe("Emojery — You're signed in"));
    // Nowhere to go back to: the tab closes itself on the same countdown instead.
    expect(document.querySelector(COUNTDOWN_SELECTOR)).not.toBeNull();
    expect(sentOfType("auth:returnToOrigin")).toHaveLength(0);
  });

  it("closes its own tab when the sign-in started outside a page", async () => {
    install();
    await loadPage();
    await pick();

    await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
    const closeNow = [...document.querySelectorAll("button.primary")].find((b) => b.textContent?.trim() === "Close now");
    expect(closeNow).toBeDefined();
    await userEvent.click(closeNow as HTMLButtonElement);

    expect(sentOfType("auth:closeTab")).toEqual([{ type: "auth:closeTab" }]);
    expect(sentOfType("auth:returnToOrigin")).toHaveLength(0);
  });

  it("keeps the dead-end copy when its tab cannot be closed", async () => {
    install({ closeReply: { type: "error", code: "unavailable" } });
    await loadPage();
    await pick();

    await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
    await userEvent.click([...document.querySelectorAll("button.primary")].find((b) => b.textContent?.trim() === "Close now") as HTMLButtonElement);

    await vi.waitFor(() => expect(requireEl(document, TAGLINE_SELECTOR).textContent).toBe("You can close this tab and react on any supported page."));
    expect(document.querySelector(COUNTDOWN_SELECTOR)).toBeNull();
  });

  it.each([
    ["cancelled", "Sign-in was cancelled. Try again when you're ready."],
    ["provider_denied", "The provider did not complete the sign-in. Try again or choose another account."],
    ["enrollment_failed", "Could not register your account right now. Please try again in a minute."],
    ["client_outdated", "This version of Emojery is out of date. Update it to sign in."],
    ["device_limit", "Device limit for this month is reached. Try again next month."],
    ["unavailable", "Something went wrong. Please try again."],
  ])("maps %s to its own copy and hands the provider list back", async (refusal, copy) => {
    install({ signInReply: { type: "auth:signedIn", ok: false, refusal } });
    await loadPage();
    await pick();

    await vi.waitFor(() => expect(errorText()).toBe(copy));
    expect(heading()).toBe("Sign in to react");
    // aria wiring for the message the screen reader has to reach (WCAG): the
    // banner is an alert, and the list it belongs to points at it.
    expect(document.querySelector(AUTH_ERROR_SELECTOR)?.getAttribute("role")).toBe("alert");
    expect(document.querySelector(PROVIDER_LIST_SELECTOR)?.getAttribute("aria-describedby")).toBe(AUTH_ERROR_ID);
    // The list is still usable: the consent survives, so a second pick is one click.
    expect(providerButtons().every((b) => !b.disabled)).toBe(true);
  });

  it("keeps the longer list open after a refusal sends the page back to it", async () => {
    install({ signInReply: { type: "auth:signedIn", ok: false, refusal: "cancelled" } });
    await loadPage();
    await pick("twitch");

    await vi.waitFor(() => expect(errorText()).toBe("Sign-in was cancelled. Try again when you're ready."));
    expect(providerButtons().map((b) => b.dataset.provider)).toEqual(["google", "apple", "microsoft", "twitch", "test"]);
    expect(moreProvidersBtn()).toBeNull();
  });

  it("treats a background that answers something else as the generic refusal", async () => {
    install({ signInReply: { type: "error", code: "unavailable" } });
    await loadPage();
    await pick();

    await vi.waitFor(() => expect(errorText()).toBe("Something went wrong. Please try again."));
  });

  it("offers a retry when the provider list cannot be read, and re-asks on it", async () => {
    let listReplies = 0;
    install({ providersReply: undefined });
    shim.uninstall();
    sent = [];
    shim = installChromeShim({
      onMessage: (msg) => {
        sent.push(msg);
        const type = (msg as { type?: string }).type;
        if (type !== "auth:providers") return undefined;
        listReplies += 1;
        return listReplies === 1 ? { type: "error", code: "network" } : PROVIDERS;
      },
    });
    await loadPage();

    const retry = await vi.waitFor(() => requireEl<HTMLButtonElement>(document, "button.linkish"));
    expect(retry.textContent).toBe("Try again");
    expect(providerButtons()).toHaveLength(0);

    await userEvent.click(retry);
    await reachProviders();
    expect(sentOfType("auth:providers")).toHaveLength(2);
  });
});

describe("auth page - the return to the page the sign-in started from", () => {
  async function signInWithReturn(): Promise<void> {
    install({ signInReply: { ...OK_SIGN_IN, returnsToPage: true } });
    await loadPage();
    await pick();
    await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
  }

  it("counts down, then asks the background to take the user back", async () => {
    await signInWithReturn();

    expect(requireEl(document, TAGLINE_SELECTOR).textContent).toBe("Taking you back to the page you were on.");
    // The seconds and the draining bar are decoration over the sentence above -
    // a screen reader gets the sentence once, not a tick per second.
    expect(requireEl(document, COUNTDOWN_SELECTOR).getAttribute("aria-hidden")).toBe("true");
    expect(requireEl(document, `${COUNTDOWN_SELECTOR} .seconds`).textContent).toBe("10");
    // The primary action holds focus, since the provider buttons it replaced are gone.
    await vi.waitFor(() => expect((document.activeElement as HTMLElement | null)?.className).toBe("primary"));
    // Going back is the only control the step offers - the tab closes itself,
    // and closing it by hand is how a user stays put.
    expect(document.querySelectorAll("#app button")).toHaveLength(1);
  });

  it("fires the return by itself once the countdown runs out", async () => {
    install({ signInReply: { ...OK_SIGN_IN, returnsToPage: true } });
    await loadPage();
    await reachProviders();
    await userEvent.click(termsBox());
    // The clock is faked before the done step mounts: its first tick is set on
    // mount, and a tick set on the real clock keeps counting there.
    vi.useFakeTimers();
    await userEvent.click(providerButton("google"));
    await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
    const returned = () => sentOfType("auth:returnToOrigin").length > 0;

    // Nine ticks leave a second on the clock; the tenth spends it.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(returned()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(returned()).toBe(true);
  });

  it("goes back at once when asked, without waiting out the countdown", async () => {
    await signInWithReturn();
    await userEvent.click(primaryBtn());

    expect(sentOfType("auth:returnToOrigin")).toHaveLength(1);
  });

  it("falls back to the dead-end copy when the origin tab went away mid-countdown", async () => {
    install({ signInReply: { ...OK_SIGN_IN, returnsToPage: true }, returnReply: { type: "error", code: "unavailable", message: "gone" } });
    await loadPage();
    await pick();
    await vi.waitFor(() => expect(heading()).toBe("You're signed in"));
    await userEvent.click(primaryBtn());

    await vi.waitFor(() => expect(document.querySelector(COUNTDOWN_SELECTOR)).toBeNull());
    expect(requireEl(document, TAGLINE_SELECTOR).textContent).toBe("You can close this tab and react on any supported page.");
  });
});

describe("auth page - the legacy consent gate", () => {
  it("shows the disclosure first on ?consent=1, then the sign-in form", async () => {
    install();
    history.replaceState({}, "", `${PAGE_URL}${PAGE_URL.includes("?") ? "&" : "?"}consent=1`);
    await loadPage();

    expect(heading()).toBe("What Emojery sends");
    expect(document.title).toBe("What Emojery sends");
    expect(document.querySelector(PROVIDER_LIST_SELECTOR)).toBeNull();
    // Nothing is asked of the background until the disclosure is acknowledged.
    expect(sentOfType("auth:providers")).toHaveLength(0);

    // The policy closes the disclosure paragraph as its last sentence - it was a
    // block of its own, which read as a second button beside Continue.
    const body = requireEl(document, "#app .tagline");
    expect(body.querySelector("a")?.textContent).toBe("Privacy Policy.");

    await userEvent.click(primaryBtn());
    expect(heading()).toBe("Sign in to react");
    // The consent title is the gate's alone: the sign-in form brings its own.
    await vi.waitFor(() => expect(document.title).toBe("Emojery — Sign in"));
    await reachProviders();
  });

  it("goes straight to sign-in without the flag", async () => {
    install();
    await loadPage();
    expect(heading()).toBe("Sign in to react");
  });
});
