// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Report tab's gates and its submit round-trip: signed-out, unsupported
// page, the 10-character note rule, and what a failed send leaves on screen.
// The failure path is the one that matters most - an unreported failure looked
// exactly like a sent report, so the error and the preserved note are pinned.
import { h } from "preact";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { AUTH_KEY } from "../../shared/auth-session";
import { mountContainer, renderAndSettle, requireEl, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim, makeLiveAuthSession } from "../../test/chrome-shim";
import { ReportView } from "./popup-report";

const GITHUB_TAB = { url: "https://github.com/torvalds/linux", id: 1 };
const LIVE_AUTH = makeLiveAuthSession();
const LONG_ENOUGH = "the button never shows up here";

let chromeShim: ChromeShimHandle;
let container: HTMLDivElement;
let sent: unknown[];

interface Options {
  authed?: boolean;
  activeTab?: { url?: string; id?: number };
  reportReply?: unknown;
}

function install({ authed = true, activeTab = GITHUB_TAB, reportReply = { type: "ok" } }: Options = {}): void {
  sent = [];
  chromeShim = installChromeShim({
    activeTab,
    local: authed ? { [AUTH_KEY]: LIVE_AUTH } : {},
    onMessage: (msg) => {
      sent.push(msg);
      return (msg as { type?: string }).type === "report" ? reportReply : undefined;
    },
  });
}

/**
 * The view resolves auth + the active tab in effects, and renders an EMPTY
 * `section.report` until both land - so waiting on that section would match the
 * placeholder. Wait for one of the settled outcomes instead.
 */
const mountAndSettle = () => renderAndSettle(container, h(ReportView, {}), "textarea, .empty-note, .signin-prompt-msg, .report-success");

const sendButton = (): HTMLButtonElement => requireEl(container, "button.report-send");

const noteField = (): HTMLTextAreaElement => requireEl(container, "textarea");

beforeEach(() => {
  container = mountContainer();
});

afterEach(() => {
  unmountContainer(container);
  chromeShim.uninstall();
});

describe("ReportView - gates", () => {
  it("asks a signed-out user to sign in, and sends nothing", async () => {
    install({ authed: false });
    await mountAndSettle();
    expect(container.querySelector(".signin-prompt-msg")?.textContent).toBe("Sign in to submit a bug report.");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("explains itself on an unsupported page instead of offering a form", async () => {
    install({ activeTab: { url: "https://example.com/", id: 1 } });
    await mountAndSettle();
    expect(container.querySelector(".empty-note")?.textContent).toContain("open the page where reactions aren't working");
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("treats an unreadable tab URL as unsupported", async () => {
    install({ activeTab: { url: "chrome://extensions", id: 1 } });
    await mountAndSettle();
    expect(container.querySelector(".empty-note")).not.toBeNull();
  });
});

describe("ReportView - the note length rule", () => {
  it("keeps Send disabled until the note reaches 10 characters, and says why", async () => {
    install();
    await mountAndSettle();
    expect(sendButton().disabled).toBe(true);

    await userEvent.fill(noteField(), "too short");
    expect(sendButton().disabled).toBe(true);
    // Pins the below-field hint and its aria-describedby wiring (rationale in
    // popup-report.tsx).
    const hint = container.querySelector("#report-note-hint");
    expect(hint?.textContent).toContain("10-500");
    expect(noteField().getAttribute("aria-describedby")).toBe("report-note-hint");

    await userEvent.fill(noteField(), LONG_ENOUGH);
    expect(sendButton().disabled).toBe(false);
    expect(container.querySelector("#report-note-hint")).toBeNull();
  });

  it("counts the TRIMMED note, so whitespace cannot buy the 10 characters", async () => {
    install();
    await mountAndSettle();
    await userEvent.fill(noteField(), "   short     ");
    expect(sendButton().disabled).toBe(true);
  });
});

describe("ReportView - submit", () => {
  it("sends the detected site and canonical URL, then confirms", async () => {
    install();
    await mountAndSettle();
    await userEvent.fill(noteField(), LONG_ENOUGH);
    await userEvent.click(sendButton());

    await vi.waitFor(() => expect(container.querySelector(".report-success")).not.toBeNull());
    const report = sent.find((m) => (m as { type?: string }).type === "report") as Record<string, unknown>;
    expect(report).toMatchObject({ type: "report", site: "github", host: "github.com", note: LONG_ENOUGH });
    expect(report.url).toContain("github.com/torvalds/linux");
    expect(container.querySelector('[role="status"]')?.textContent).toContain("report sent");
  });

  it("keeps the note and shows an alert when the send fails", async () => {
    install({ reportReply: { type: "error", code: "unavailable" } });
    await mountAndSettle();
    await userEvent.fill(noteField(), LONG_ENOUGH);
    await userEvent.click(sendButton());

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    expect(container.querySelector(".report-error")?.textContent).toContain("Could not send");
    // Nothing was lost: the user can retry without retyping.
    expect(noteField().value).toBe(LONG_ENOUGH);
    expect(container.querySelector(".report-success")).toBeNull();
  });

  // The background classifies every failure (background/respond.ts); these two codes are
  // the ones a user can act on, so the alert says which it is instead of one generic line.
  // `unavailable` keeps the report-specific wording above - that fall-through is the point.
  it.each([
    ["network", "offline"],
    ["rate_limited", "Too many requests"],
  ] as const)("tells the user WHY a %s failure happened", async (code, expected) => {
    install({ reportReply: { type: "error", code } });
    await mountAndSettle();
    await userEvent.fill(noteField(), LONG_ENOUGH);
    await userEvent.click(sendButton());

    await vi.waitFor(() => expect(container.querySelector('[role="alert"]')).not.toBeNull());
    const text = container.querySelector(".report-error")?.textContent ?? "";
    expect(text).toContain(expected);
    // ...and it is NOT the generic line, which is what made the classification pointless.
    expect(text).not.toContain("Could not send the report");
    expect(noteField().value).toBe(LONG_ENOUGH);
  });

  it("returns to an empty form from the success state", async () => {
    install();
    await mountAndSettle();
    await userEvent.fill(noteField(), LONG_ENOUGH);
    await userEvent.click(sendButton());
    await vi.waitFor(() => expect(container.querySelector(".report-success")).not.toBeNull());

    await userEvent.click(requireEl<HTMLButtonElement>(container, ".report-success button"));
    expect(noteField().value).toBe("");
    expect(sendButton().disabled).toBe(true);
  });
});
