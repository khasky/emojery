// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Account tab's session states and its one destructive control. Signing in
// itself is e2e's (auth.spec.ts, against a real backend); what lives only here
// is what the tab does with the answer - the signed-out gate, the identity line
// a pre-email session falls back to, and the delete flow: arm, cancel (with the
// focus hand-back), confirm, and what a refused delete leaves on screen.
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
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
  email?: string | null;
  deleteReply?: unknown;
}

// Stateful on purpose: the view re-reads auth:status after sign-out and after a
// delete, so the answer has to change the way the background's would.
function install({ authed = true, email = "user@example.com", deleteReply = { type: "ok" } }: Options = {}): void {
  sent = [];
  let signedIn = authed;
  shim = installChromeShim({
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
      if (type === "auth:status") return { type: "auth:status", authed: signedIn, userId: signedIn ? USER_ID : null, email: signedIn ? email : null };
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

// Arm the confirm and wait for the slide thumb to actually HOLD focus. WebKit
// finishes its own click focus handling after the arming effect ran (measured:
// activeElement is <body> right after the click there, the thumb only once it
// settles), so a keystroke sent immediately goes to <body> and the slide never
// happens - a CI-only red on the slower runner. Also the WCAG 2.4.3 assert:
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

    expect(container.querySelector(".signin-prompt-msg")?.textContent).toBe("Sign in to manage your account.");
    expect(container.querySelector(".acct-list")).toBeNull();
    expect(sentTypes()).toEqual(["auth:status"]);
  });

  it("shows the signed-in address, and the delete control with it", async () => {
    install();
    await mountAndSettle();

    const row = container.querySelector(".acct-list .row");
    expect(row?.textContent).toContain("Signed in");
    expect(row?.querySelector(".row-hint")?.textContent).toBe("user@example.com");
    expect(button("Delete")).toBeDefined();
  });

  it("falls back to a truncated user id for a session minted before the email field", async () => {
    install({ email: null });
    await mountAndSettle();

    expect(container.querySelector(".row-hint")?.textContent).toBe("id: abcdefgh…");
  });

  it("signs out and lands back on the sign-in prompt", async () => {
    install();
    await mountAndSettle();
    await userEvent.click(button("Sign out"));

    await vi.waitFor(() => expect(container.querySelector(".signin-prompt-msg")).not.toBeNull());
    // Signed out, then re-read: the tab never keeps a stale signed-in header.
    expect(sentTypes()).toEqual(["auth:status", "auth:signOut", "auth:status"]);
  });
});

describe("AccountView - deleting the account", () => {
  it("needs the slide, not the Delete button, to send anything", async () => {
    install();
    await mountAndSettle();
    await userEvent.click(button("Delete"));

    expect(container.querySelector(".delete-confirm-warn")?.textContent).toContain("permanent and cannot be undone");
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
    // End is the slider's keyboard path to a full slide (WCAG 2.1.1).
    await userEvent.keyboard("{End}");

    await vi.waitFor(() => expect(container.querySelector(".signin-prompt-msg")).not.toBeNull());
    expect(sentTypes()).toEqual(["auth:status", "auth:delete", "auth:status"]);
  });

  it("keeps the account and the confirm on screen when the delete is refused", async () => {
    install({ deleteReply: { type: "error", code: "unavailable" } });
    await mountAndSettle();
    await armDeleteConfirm();
    await userEvent.keyboard("{End}");

    // Back from "Deleting…" to the confirm, still signed in - a failure that
    // looked like a completed delete would be the dangerous outcome here.
    await vi.waitFor(() => expect(container.querySelector(".delete-confirm-warn")).not.toBeNull());
    expect(container.querySelector(".delete-confirm-progress")).toBeNull();
    expect(container.querySelector(".acct-list")).not.toBeNull();
  });
});
