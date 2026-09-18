// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Account tab's session states and its one destructive control. Signing in
// itself is e2e's (auth.spec.ts, against a real backend); what lives only here
// is what the tab does with the answer - the signed-out gate, the identity line
// a session with no provider falls back to, and the delete flow: arm, cancel (with the
// focus hand-back), confirm, and what a refused delete leaves on screen.
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { accountDisplayName } from "../../shared/account-names";
import { EPOCH_KEY_LIMIT_KEY } from "../../shared/epoch-key-limit";
import { ACCOUNT_LIST_SELECTOR, ACCOUNT_NAME_INPUT_SELECTOR, ACCOUNT_NAME_SELECTOR, DELETE_CONFIRM_WARN_SELECTOR, DEVICE_LIMIT_NOTICE_SELECTOR, SIGNIN_PROMPT_MSG_SELECTOR } from "../../shared/page-dom";
import { DEFAULT_SETTINGS } from "../../shared/storage";
import { mountContainer, renderAndSettle, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim } from "../../test/chrome-shim";
import { AccountView } from "./popup-account";

const USER_ID = "abcdefgh-1234-5678-9012-abcdefabcdef";

let shim: ChromeShimHandle;
let container: HTMLDivElement;
let sent: unknown[];

interface Options {
  authed?: boolean;
  provider?: string | null;
  deleteReply?: unknown;
  local?: Record<string, unknown>;
}

// Stateful: the view re-reads auth:status after sign-out and after a
// delete, so the answer has to change the way the background's would.
function install({ authed = true, provider = "google", deleteReply = { type: "ok" }, local }: Options = {}): void {
  sent = [];
  let signedIn = authed;
  shim = installChromeShim({
    ...(local ? { local } : {}),
    onMessage: (msg) => {
      const type = (msg as { type?: string }).type;
      sent.push(msg);
      if (type === "auth:signOut") {
        signedIn = false;
        return { type: "ok" };
      }
      if (type === "auth:delete") {
        if ((deleteReply as { type?: string }).type === "ok") signedIn = false;
        return deleteReply;
      }
      if (type === "auth:status") return { type: "auth:status", authed: signedIn, userId: signedIn ? USER_ID : null, provider: signedIn ? provider : null };
      return undefined;
    },
  });
}

const noopUpdate = async (): Promise<void> => {};

/** The view renders null until auth:status lands - wait for either settled state. */
const mountAndSettle = () => renderAndSettle(container, h(AccountView, { settings: DEFAULT_SETTINGS, update: noopUpdate }), ".acct-list, .signin-prompt-msg");

const button = (label: string): HTMLButtonElement => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`button not rendered: ${label}`);
  return found;
};

// Account messages only: the History section mounted alongside does its own reads.
const sentTypes = (): string[] => sent.map((m) => (m as { type: string }).type).filter((type) => type.startsWith("auth:"));

// Arm the confirm and wait for the slide thumb to HOLD focus. WebKit
// finishes its own click focus handling after the arming effect ran (measured:
// activeElement is <body> right after the click there, the thumb only once it
// settles), so a keystroke sent immediately goes to <body> and the slide never
// happens - a CI-only red on the slower runner. Also the focus-order assert:
// the arming button unmounts, so the thumb has to take the focus it left.
async function armDeleteConfirm(): Promise<void> {
  await userEvent.click(button("Delete"));
  const thumb = container.querySelector('[role="slider"]');
  await vi.waitFor(() => expect(document.activeElement).toBe(thumb));
}

beforeEach(() => {
  container = mountContainer();
});

afterEach(() => {
  unmountContainer(container);
  shim.uninstall();
});

describe("AccountView - session states", () => {
  it("asks a signed-out user to sign in, and offers no account controls", async () => {
    install({ authed: false });
    await mountAndSettle();

    expect(container.querySelector(SIGNIN_PROMPT_MSG_SELECTOR)?.textContent).toBe("Sign in to manage your account.");
    expect(container.querySelector(ACCOUNT_LIST_SELECTOR)).toBeNull();
    expect(sentTypes()).toEqual(["auth:status"]);
  });

  it("names the provider the account came from, and the delete control with it", async () => {
    install();
    await mountAndSettle();

    const row = container.querySelector(`${ACCOUNT_LIST_SELECTOR} .row`);
    expect(row?.textContent).toContain("Your account");
    // The provider, then which account: `openid` alone gives no address to show, and
    // one reader can hold several accounts at the same provider.
    await vi.waitFor(() => expect(row?.querySelector(".row-hint")?.textContent).toMatch(/^Google · [a-z]+-[a-z]+$/));
    expect(button("Delete")).toBeDefined();
  });

  it("renames the account to what the reader typed, and keeps it after a reopen", async () => {
    install();
    await mountAndSettle();

    const nameButton = () => container.querySelector<HTMLButtonElement>(ACCOUNT_NAME_SELECTOR);
    // `element.click()`, not a pointer: this harness mounts the component without the
    // popup stylesheet, so the row's icon renders at its intrinsic size and covers the
    // name. A real popup has the stylesheet and the pointer lands; what is under test
    // here is the rename, not hit-testing.
    await vi.waitFor(() => expect(nameButton()).not.toBeNull());
    (nameButton() as HTMLButtonElement).click();
    await vi.waitFor(() => expect(container.querySelector(ACCOUNT_NAME_INPUT_SELECTOR)).not.toBeNull());
    const field = container.querySelector<HTMLInputElement>(ACCOUNT_NAME_INPUT_SELECTOR) as HTMLInputElement;
    await userEvent.clear(field);
    await userEvent.type(field, "work");
    await userEvent.keyboard("{Enter}");

    await vi.waitFor(() => expect(nameButton()?.textContent).toBe("work"));
    // Stored, not just rendered: the popup is torn down on every close.
    await expect(accountDisplayName(USER_ID)).resolves.toBe("work");
  });

  it("still names the account when the session carries no provider", async () => {
    install({ provider: null });
    await mountAndSettle();

    // The label is derived from the account id, so it stands on its own.
    await vi.waitFor(() => expect(container.querySelector(".row-hint")?.textContent).toMatch(/^[a-z]+-[a-z]+$/));
  });

  it("signs out and lands back on the sign-in prompt", async () => {
    install();
    await mountAndSettle();
    await userEvent.click(button("Sign out"));

    await vi.waitFor(() => expect(container.querySelector(SIGNIN_PROMPT_MSG_SELECTOR)).not.toBeNull());
    // Signed out, then re-read: the tab never keeps a stale signed-in header.
    expect(sentTypes()).toEqual(["auth:status", "auth:signOut", "auth:status"]);
  });
});

describe("AccountView - device limit notice", () => {
  const RESUMES_AT = Date.UTC(2026, 9, 1, 12);

  it("says until when voting is paused while the notice stands", async () => {
    install({ local: { [EPOCH_KEY_LIMIT_KEY]: { epoch: 41, resumesAt: RESUMES_AT } } });
    await mountAndSettle();

    await vi.waitFor(() => expect(container.querySelector(DEVICE_LIMIT_NOTICE_SELECTOR)).not.toBeNull());
    const notice = container.querySelector(DEVICE_LIMIT_NOTICE_SELECTOR)!;
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.textContent).toBe(`Device limit for this month is reached. Voting resumes on ${new Date(RESUMES_AT).toLocaleDateString(navigator.language, { year: "numeric", month: "long", day: "numeric" })}.`);
  });

  it("shows nothing once the epoch it names has passed, and drops the stale notice", async () => {
    install({ local: { [EPOCH_KEY_LIMIT_KEY]: { epoch: 1, resumesAt: Date.now() - 1 } } });
    await mountAndSettle();

    await vi.waitFor(() => expect(shim.local.has(EPOCH_KEY_LIMIT_KEY)).toBe(false));
    expect(container.querySelector(DEVICE_LIMIT_NOTICE_SELECTOR)).toBeNull();
  });

  it("shows nothing for a signed-in account without one", async () => {
    install();
    await mountAndSettle();
    expect(container.querySelector(DEVICE_LIMIT_NOTICE_SELECTOR)).toBeNull();
  });
});

describe("AccountView - deleting the account", () => {
  it("needs the slide, not the Delete button, to send anything", async () => {
    install();
    await mountAndSettle();
    await userEvent.click(button("Delete"));

    expect(container.querySelector(DELETE_CONFIRM_WARN_SELECTOR)?.textContent).toContain("permanent and cannot be undone");
    expect(container.querySelector('[role="slider"]')).not.toBeNull();
    expect(sentTypes()).toEqual(["auth:status"]);
  });

  it("hands focus back to the Delete button when the confirm is cancelled", async () => {
    install();
    await mountAndSettle();
    await userEvent.click(button("Delete"));
    // Cancelling unmounts the slide control, so focus would fall to <body>.
    await userEvent.click(button("Cancel"));
    // WebKit finishes its own click focus handling after the effect runs, so the
    // hand-back is the settled state, not the immediate one.
    await vi.waitFor(() => expect(document.activeElement).toBe(button("Delete")));
  });

  it("sends the delete once the slider lands, then shows the signed-out state", async () => {
    install();
    await mountAndSettle();
    await armDeleteConfirm();
    // End is the slider's keyboard path to a full slide (WCAG).
    await userEvent.keyboard("{End}");

    await vi.waitFor(() => expect(container.querySelector(SIGNIN_PROMPT_MSG_SELECTOR)).not.toBeNull());
    expect(sentTypes()).toEqual(["auth:status", "auth:delete", "auth:status"]);
  });

  it("keeps the account and the confirm on screen when the delete is refused", async () => {
    install({ deleteReply: { type: "error", code: "unavailable" } });
    await mountAndSettle();
    await armDeleteConfirm();
    await userEvent.keyboard("{End}");

    // Back from "Deleting..." to the confirm, still signed in - a failure that
    // looked like a completed delete would be the dangerous outcome here.
    await vi.waitFor(() => expect(container.querySelector(DELETE_CONFIRM_WARN_SELECTOR)).not.toBeNull());
    expect(container.querySelector(".delete-confirm-progress")).toBeNull();
    expect(container.querySelector(ACCOUNT_LIST_SELECTOR)).not.toBeNull();
  });
});
