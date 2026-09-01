// SPDX-License-Identifier: GPL-3.0-or-later
//
// Authed autonomous gap coverage the site-injection / auth specs do NOT cover.
// The reaction cases run on GitHub, where the picker mounts without any platform login
// (no anti-bot exposure); the popup's own page doubles as the unsupported-page fixture.
// Verification is VISUAL: the shadow-hosted trigger/counter and the extension's own
// popup DOM - exactly what a user perceives.
import { expect, type Page, test } from "@playwright/test";
import * as ext from "./lib/extension";
import { pollForValue } from "./lib/picker-probes";
import { reloadAndSettle } from "./lib/reload-settle";

const REQUIRES_OTP = ext.otpSkipReason("authed extras");

// Between reads of a public counter. Each read reloads the page, and the server-side count
// cache is what the wait is really for - polling faster only reloads more.
const COUNT_SETTLE_POLL_MS = 12_000;

// Whole file signs in through auth.html and drives the popup, which Playwright Firefox cannot
// reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);

// Needs no sign-in (hosts mount unauthed too), so it always runs.
test("settings: master Enabled toggle removes and restores the picker", async () => {
  const session = await ext.launchSession();
  try {
    const page = await ext.openGithub(session.context);
    await expect.poll(() => ext.visibleHostCount(page), { message: "picker should mount by default" }).toBeGreaterThan(0);

    await ext.setPopupCheckbox(session.context, {
      tab: "Settings",
      name: "Enabled",
      checked: false,
    });
    // Give a would-be mount time to happen, so the zero-read below means removed, not
    // not-yet-scanned.
    await reloadAndSettle(page, 1_500);
    await expect.poll(() => ext.visibleHostCount(page), { message: "master off should remove the picker" }).toBe(0);

    await ext.setPopupCheckbox(session.context, {
      tab: "Settings",
      name: "Enabled",
      checked: true,
    });
    await reloadAndSettle(page, 1_500);
    await expect.poll(() => ext.visibleHostCount(page), { message: "master on should restore the picker" }).toBeGreaterThan(0);
  } finally {
    await ext.closeSession(session);
  }
});

// Asserts the DELTA around known toggles, so it is independent of any
// pre-existing (seeded) count on the target.
test("counter: a reaction increments and un-reaction decrements the aggregate", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    const page = await ext.signedInGithubPage(session.context);

    await ext.clearReaction(page);
    await expect.poll(() => ext.hasOwnReaction(page)).toBe(false);
    // Settled read: the trigger renders its plain (uncounted) form until the
    // count fetch lands, so an immediate read can report null on a target that
    // carries reactions - and a 0 baseline off that read fails the delta below
    // by the target's whole real total.
    const baseTotal = await ext.readSettledTotal(page);

    await ext.reactWith(page, ext.REACTIONS.heart);
    await expect.poll(() => ext.hasOwnReaction(page)).toBe(true);
    const reacted = await ext.readCounter(page);
    expect(reacted.isCounter, "trigger should become a counter").toBe(true);
    expect(/\d/.test(reacted.text), `counter text should show a number (was "${reacted.text}")`).toBe(true);
    // The reacted total must parse: one reaction is held by now, so the counter
    // form is mandatory - unlike the baseline, which a bare target leaves plain.
    expect(reacted.total, "reacted aggregate should parse as a number").not.toBeNull();
    expect(reacted.total, "aggregate should increment by one").toBe(baseTotal + 1);

    await ext.clearReaction(page);
    await expect.poll(() => ext.hasOwnReaction(page)).toBe(false);
    const cleared = await ext.readCounter(page);
    expect(cleared.total ?? 0, "aggregate should decrement back to baseline").toBe(baseTotal);
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// The queued offline vote must flush on reconnect and survive a reload - a real
// server round-trip, not just optimistic UI.
test("offline: a reaction made offline persists after reconnect + reload", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    const page = await ext.signedInGithubPage(session.context);
    await ext.clearReaction(page);
    // Same render wait as the counter tests: while the cleared reaction is still
    // shown, reactWith sees its option already pressed and skips the click, so
    // nothing is reacted offline.
    await expect.poll(() => ext.hasOwnReaction(page)).toBe(false);

    await session.context.setOffline(true);
    await ext.reactWith(page, ext.REACTIONS.heart);
    await expect
      .poll(() => ext.hasOwnReaction(page), {
        message: "reaction should appear optimistically while offline",
      })
      .toBe(true);

    await session.context.setOffline(false);
    // Let the reconnect flush POST the queued vote before the reload re-reads server state.
    await page.waitForTimeout(3_000);
    await reloadAndSettle(page, 2_500);
    await expect
      .poll(() => ext.hasOwnReaction(page), {
        message: "the offline reaction should persist after reconnect + reload",
        timeout: 20_000,
      })
      .toBe(true);
  } finally {
    await session.context.setOffline(false).catch(() => {});
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// Deleting the account signs the user out AND removes the votes it cast,
// observed exactly as a USER does: the public counter on the trigger rises when
// you react and drops back after you delete. Signs in with a SEPARATE unique
// per-run address on the configured test domain so destroying that account
// never poisons the primary one. Public counts settle with a delay, so each
// check waits and re-reads the RENDERED counter - never a direct API read.
test("account deletion: signs out and reverses its reactions", async () => {
  test.skip(!ext.authConfigured(), ext.otpSkipReason("account deletion"));
  // Generous: we wait for the public counts to settle TWICE - once to see the
  // vote land in the public counter, once to see it removed.
  test.setTimeout(Number(process.env.E2E_DELETE_TEST_TIMEOUT_MS ?? 600_000));
  const CACHE_WAIT = ext.COUNT_CACHE_WAIT_MS;
  const HEART = ext.REACTIONS.heart;
  const session = await ext.launchSession();
  const reacted: Array<{ page: Page; mountKey: string; minimum: number }> = [];
  const withVote: Array<{ page: Page; mountKey: string; countWith: number }> = [];
  try {
    await ext.signIn(session.context, ext.authEmail("delete"), ext.authOtp());

    // React on a couple of login-free repo/project surfaces; keep each page open
    // so its RENDERED counter can be re-read after the counts settle.
    for (const url of [ext.githubUrl(), ext.gitlabUrl()]) {
      const page = await ext.openSite(session.context, url, { requireHost: false });
      const mountKey = await ext.firstMountedKey(page, url.includes("gitlab") ? "gitlab:" : "github:");
      if (!mountKey) {
        await page.close().catch(() => {});
        continue; // surface not reactable this run - skip it
      }
      // Settle the PUBLIC baseline before reacting: the rendered counter takes a
      // while to catch up with the true total, so a single early read is stale
      // and an absolute `before+1` expectation then flakes (off by one). The
      // baseline is at rest here (no vote in flight yet), so it settles fast.
      const before = await ext.waitForSettledTotal(page);
      const alreadyReacted = await ext.hasOwnReaction(page);
      await ext.reactWith(page, HEART);
      expect(await ext.hasOwnReaction(page), `the disposable account should hold a reaction on ${mountKey}`).toBe(true);
      // The lowest public count that can carry this account's reaction: before+1
      // for a fresh react, or `before` if it already held one (reactWith was then
      // a no-op).
      reacted.push({ page, mountKey, minimum: alreadyReacted ? before : before + 1 });
    }
    expect(reacted.length, "at least one target must be reacted on before the deletion check").toBeGreaterThan(0);

    // Wait #1 - the RENDERED counter must reflect this account's vote once the
    // public count settles: proves the server recorded it, so the post-deletion
    // revert is meaningful.
    //
    // AT LEAST the minimum, and the drop below is anchored on what the counter
    // ACTUALLY reads here rather than on `before + 1`. These targets are public
    // and shared with the specs that ran before this one (accounts.spec reacts on
    // the same repo), so the baseline can still be catching up with someone
    // else's vote - an absolute expectation then misses by one and only passes on
    // the retry, which re-reads a settled baseline (seen live: 82 vs 81).
    for (const { page, mountKey, minimum } of reacted) {
      // pollForValue, not expect.poll: the assertion below is `>=`, but the drop check
      // after the deletion needs the value this actually settled on.
      const countWith = await pollForValue(
        async () => (await ext.reloadAndReadTotal(page)) ?? 0,
        (total) => total >= minimum,
        CACHE_WAIT,
        COUNT_SETTLE_POLL_MS,
      );
      expect(countWith, `rendered counter for ${mountKey} should reach at least ${minimum} once the counts settle`).toBeGreaterThanOrEqual(minimum);
      withVote.push({ page, mountKey, countWith });
    }

    // Delete the account via the slide-to-confirm safeguard: the "Delete" button
    // only ARMS it (reveals the slider); the actual deletion fires when the ARIA
    // slider lands - focus the thumb and press End (SlideToConfirm's keyboard path).
    const popup = await ext.openPopup(session.context);
    try {
      await popup.getByRole("tab", { name: "Account" }).click();
      const deleteBtn = popup.getByRole("button", { name: "Delete" });
      await expect(deleteBtn, "Delete button is only shown when signed in").toBeVisible();
      await deleteBtn.click();
      const slider = popup.getByRole("slider");
      await expect(slider, "slide-to-confirm should appear after arming delete").toBeVisible();
      await slider.focus();
      await popup.keyboard.press("End");
      // After deletion the auth session is cleared; the Account tab returns to the signed-out
      // CTA.
      await expect(popup.getByRole("button", { name: "Sign in" })).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await popup.close().catch(() => {});
    }
    expect(await ext.isSignedIn(session.context), "account should be signed out after deletion").toBe(false);

    // Wait #2 - deletion removes the account's votes: once the public count
    // settles each RENDERED counter must drop back by exactly its one reaction.
    for (const { page, mountKey, countWith } of withVote) {
      await expect
        .poll(async () => (await ext.reloadAndReadTotal(page)) ?? 0, {
          message: `rendered counter for ${mountKey} should drop to ${countWith - 1} after deletion`,
          timeout: CACHE_WAIT,
          intervals: [COUNT_SETTLE_POLL_MS],
        })
        .toBe(countWith - 1);
    }
  } finally {
    for (const { page } of reacted) await page.close().catch(() => {});
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// Report gate: on a non-supported active tab (the popup's own page) the Report tab shows the
// "open a supported page" notice.
test("report: shows the unsupported-page notice off a supported site", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    await ext.signIn(session.context);
    const popup = await ext.openPopup(session.context);
    try {
      await popup.getByRole("tab", { name: "Report" }).click();
      await expect(popup.getByText(ext.enMessage("reportUnsupportedPage"), { exact: true })).toBeVisible();
    } finally {
      await popup.close().catch(() => {});
    }
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// The Report form only renders when the popup's active-tab lookup resolves to a
// supported site, so open the popup as a BACKGROUND tab (active:false) while
// GitHub stays the active tab - no dependency on the flaky chrome.action.openPopup().
test("report: submits a bug report on a supported page", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  test.skip(ext.isFirefoxRun(), "opens the popup via a tabs.create call in the background context, which Playwright cannot reach on Firefox (MV2 background page)");
  const session = await ext.launchSession();
  try {
    await ext.signIn(session.context);
    const page = await ext.openGithub(session.context);
    await page.bringToFront();

    const extensionId = await ext.resolveExtensionId(session.context);
    expect(extensionId, "extension must be loaded").not.toBeNull();
    if (!extensionId) return;
    const sw = await ext.firstServiceWorker(session.context);

    const popupPromise = session.context.waitForEvent("page");
    await sw.evaluate(
      (url) =>
        (
          globalThis as unknown as {
            chrome: { tabs: { create: (p: { url: string; active: boolean }) => Promise<unknown> } };
          }
        ).chrome.tabs.create({ url, active: false }),
      ext.extensionPageUrl(extensionId, "popup.html"),
    );
    const popup = await popupPromise;
    try {
      await expect(popup.getByRole("heading", { name: "Emojery" })).toBeVisible();
      await page.bringToFront(); // keep GitHub active when ReportView mounts
      await popup.getByRole("tab", { name: "Report" }).click();
      // The form rendering at all proves the supported-site gate passed.
      const textarea = popup.locator("textarea");
      await expect(textarea).toBeVisible();
      const sendBtn = popup.getByRole("button", { name: "Send report" });
      // Under 10 chars the submit stays disabled.
      await textarea.fill("short");
      await expect(sendBtn).toBeDisabled();
      // The field's cap, asserted on the element and then used to build the overlong note
      // and the expected truncation - one number, so the three cannot drift apart.
      const noteMax = 500;
      await expect(textarea).toHaveAttribute("maxlength", String(noteMax));
      await textarea.fill("");
      const overlongNote = `Automated e2e report: ${"x".repeat(noteMax + 20)}`;
      await textarea.focus();
      await popup.keyboard.insertText(overlongNote);
      await expect(textarea).toHaveValue(overlongNote.slice(0, noteMax));
      await expect(sendBtn).toBeEnabled();
      await sendBtn.click();
      await expect(popup.getByText(ext.enMessage("reportSent"), { exact: true })).toBeVisible();
    } finally {
      await popup.close().catch(() => {});
    }
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// Rapid back-to-back reaction switches must settle on the LAST pick and never
// corrupt the aggregate: a switch keeps the total unchanged, so the end state is
// exactly one held reaction and base+1 - never doubled, never negative.
test("rapid reaction switching settles on the last pick without corrupting the counter", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    const page = await ext.signedInGithubPage(session.context);

    await ext.clearReaction(page);
    // Wait for the un-react to RENDER before reading the baseline, exactly as the
    // counter test above does. The picker applies its optimistic delta only after
    // the content script's auth round-trip to the service worker resolves
    // (ui/vote-client.ts createOnPick), so clearReaction's fixed post-click wait
    // can return while the cleared reaction is still on screen - `data-active` and
    // the aria-label total come from the same PickerTrigger render, so the
    // baseline is then one too high and the end state lands on `base`, not `base + 1`.
    await expect.poll(() => ext.hasOwnReaction(page)).toBe(false);
    // Settled read: an un-counted trigger this early is usually one whose count
    // fetch has not landed, and a 0 baseline off that read makes the delta below
    // fail by the target's whole real total.
    const base = await ext.readSettledTotal(page);

    for (const emoji of [ext.REACTIONS.heart, ext.REACTIONS.fire, ext.REACTIONS.heart, ext.REACTIONS.fire]) {
      await ext.reactWith(page, emoji);
    }

    await expect.poll(() => ext.hasOwnReaction(page)).toBe(true);
    expect(await ext.isReactionChecked(page, ext.REACTIONS.fire), "last pick (🔥) wins").toBe(true);
    expect(await ext.isReactionChecked(page, ext.REACTIONS.heart), "earlier pick (❤️) cleared").toBe(false);

    const after = (await ext.readCounter(page)).total;
    // Same parseability guard as the counter test: one reaction is held here, so
    // a counter is mandatory and an unparseable read is a real failure.
    expect(after, "post-switch aggregate should parse as a number").not.toBeNull();
    expect(after, "one held reaction should raise the aggregate by exactly one").toBe(base + 1);
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// The vote POST is delayed (slow network) so it is unfinished at F5; the durable
// IndexedDB queue must carry it across the navigation and the SW re-flushes it.
test("a reaction in flight survives a reload (slow network)", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    const page = await ext.signedInGithubPage(session.context);
    // A leftover reaction from a prior test makes clearReaction send an un-react
    // vote; let it reach the server BEFORE arming the delay route, or the route
    // holds the un-react and the heart vote queues behind it into the reload.
    const unreactFlushed = ext.watchNextVoteFlush(session.context);
    const cleared = await ext.clearReaction(page);
    if (cleared) await unreactFlushed();

    // Hold the vote POST open so it is mid-flight at reload (the background SW
    // sends it; context.route intercepts service-worker requests too). Robust
    // either way: if it still completes fast, the durable queue makes it persist.
    await session.context.route("**/reactions/vote", async (route) => {
      await new Promise((r) => setTimeout(r, 4_000));
      // The reload this test performs can cancel the held request; continuing a
      // cancelled route throws ("Route is already handled") and would fail the
      // test outside any expect. The durable queue re-sends the vote either way.
      await route.continue().catch(() => {});
    });

    await ext.reactWith(page, ext.REACTIONS.heart);
    await page.reload({ waitUntil: "domcontentloaded" });

    await expect
      .poll(() => ext.hasOwnReaction(page), {
        message: "the in-flight reaction should persist after a mid-send reload",
        timeout: 30_000,
      })
      .toBe(true);
  } finally {
    await session.context.unroute("**/reactions/vote").catch(() => {});
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

test("analytics consent defaults ON and is an authed-only control", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    const consentLabel = ext.enMessage("settingAnalyticsConsent");
    let popup = await ext.openPopup(session.context);
    await popup.getByRole("tab", { name: "Account" }).click();
    await expect(popup.getByRole("checkbox", { name: consentLabel })).toHaveCount(0);
    await popup.close().catch(() => {});

    await ext.signIn(session.context);

    popup = await ext.openPopup(session.context);
    try {
      await popup.getByRole("tab", { name: "Account" }).click();
      const consent = popup.getByRole("checkbox", { name: consentLabel });
      await expect(consent, "consent toggle is shown when signed in").toBeVisible();
      await expect(consent, "consent defaults ON").toBeChecked();
    } finally {
      await popup.close().catch(() => {});
    }
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});
