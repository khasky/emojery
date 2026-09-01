// SPDX-License-Identifier: GPL-3.0-or-later
//
// Multi-account gap coverage: identity isolation across account switches,
// independent counter moves per account, email-based account recovery, and
// repeated wrong codes being refused. All flows run on
// GitHub (login-free mount surface) and read only what a user sees: the
// shadow-hosted trigger/counter, the popup History tab, and auth.html's visible errors.
import { expect, test } from "@playwright/test";
import * as ext from "./lib/extension";
import { openHistoryTab } from "./lib/popup-probes";
import { reloadAndSettle } from "./lib/reload-settle";

const REQUIRES_OTP = ext.otpSkipReason("multi-account e2e checks");

// Whole file signs in through auth.html and reads the popup, which Playwright Firefox cannot reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);

// Signing out drops a still-queued vote by design (see flushVotes), so a vote
// followed by a sign-out or teardown must first reach the server: the main
// flows await ext.watchNextVoteFlush; this budget serves the best-effort
// cleanup paths only.
const VOTE_FLUSH_MS = Number(process.env.E2E_VOTE_FLUSH_MS ?? 5_000);

// The view shows the empty state while its storage read is still in flight, so
// give an entry a grace window before trusting "empty".
async function historyState(context: Parameters<typeof ext.openPopup>[0], host: string): Promise<{ empty: boolean; hasHostEntry: boolean }> {
  const popup = await openHistoryTab(context);
  try {
    const hostEntry = popup.locator(`.history a[href*="${host}"]`).first();
    const hasHostEntry = await hostEntry
      .waitFor({ state: "visible", timeout: 8_000 })
      .then(() => true)
      .catch(() => false);
    const empty = await popup
      .getByText(ext.enMessage("historyEmpty"), { exact: true })
      .isVisible()
      .catch(() => false);
    return { empty, hasHostEntry };
  } finally {
    await popup.close().catch(() => {});
  }
}

// Switching accounts swaps the visible identity completely: A's history entry and
// selected reaction never show under B, and both return when A signs back in.
test("account switching isolates history and the own reaction", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const emailA = ext.authEmail("switch-a");
  const emailB = ext.authEmail("switch-b");
  const session = await ext.launchSession();
  let cleanupAsA = false;
  try {
    await ext.signIn(session.context, emailA);
    const page = await ext.openGithub(session.context);
    const key = await ext.firstMountedKey(page);
    expect(key, "a GitHub Emojery host should mount").not.toBeNull();
    if (!key) return;

    const voteFlushed = ext.watchNextVoteFlush(session.context);
    await ext.reactWith(page, ext.REACTIONS.heart);
    cleanupAsA = true;
    await expect.poll(() => ext.hasOwnReaction(page)).toBe(true);
    await voteFlushed();
    const historyA = await historyState(session.context, "github.com");
    expect(historyA.hasHostEntry, "account A's history should list the GitHub reaction").toBe(true);

    // Fresh account B: no history carries over and the reaction is no longer
    // "mine" (the public count may still include A's vote - aggregate data, not
    // identity).
    await ext.ensureSignedOut(session.context);
    await ext.signIn(session.context, emailB);
    const historyB = await historyState(session.context, "github.com");
    expect(historyB.hasHostEntry, "account B must not see account A's history").toBe(false);
    expect(historyB.empty, "a fresh account starts with an empty history").toBe(true);
    await reloadAndSettle(page, 2_500);
    await expect.poll(() => ext.hasOwnReaction(page), { message: "account B must not inherit account A's selected reaction" }).toBe(false);

    await ext.ensureSignedOut(session.context);
    await ext.signIn(session.context, emailA);
    const historyAgain = await historyState(session.context, "github.com");
    expect(historyAgain.hasHostEntry, "account A's history should survive the round-trip through account B").toBe(true);
    await reloadAndSettle(page, 2_500);
    await expect.poll(() => ext.hasOwnReaction(page), { message: "account A's reaction should still be selected after signing back in", timeout: 20_000 }).toBe(true);

    const unreactFlushed = ext.watchNextVoteFlush(session.context);
    await ext.clearReaction(page);
    await unreactFlushed();
    cleanupAsA = false;
  } finally {
    if (cleanupAsA) {
      // Best-effort: leave the shared staging target without this run's vote.
      await ext
        .signIn(session.context, emailA)
        .then(async () => {
          const page = await ext.openGithub(session.context);
          await ext.clearReaction(page);
        })
        .catch(() => {});
    }
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

// The account (and its reactions) is recoverable by email alone: wipe the
// profile ("uninstall + reinstall"), sign in with the SAME address from a
// brand-new profile, and the previously picked emoji is selected again while the
// local history starts empty (history is device-local by design).
test("signing in with the same email from a fresh profile restores the reaction", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const email = ext.authEmail("recover");
  const first = await ext.launchSession();
  try {
    await ext.signIn(first.context, email);
    const page = await ext.openGithub(first.context);
    expect(await ext.firstMountedKey(page), "a GitHub Emojery host should mount").not.toBeNull();
    const voteFlushed = ext.watchNextVoteFlush(first.context);
    await ext.reactWith(page, ext.REACTIONS.heart);
    await expect.poll(() => ext.hasOwnReaction(page)).toBe(true);
    // The queued vote must reach the server - the profile (and its durable
    // queue) is destroyed next, so an unflushed vote would be lost. Await the
    // wire response: a fixed sleep lost this race on a slow staging response
    // (the vote POST was cancelled mid-flight by the profile close).
    await voteFlushed();
  } finally {
    await ext.closeSession(first); // discards the generated profile dir
  }

  const second = await ext.launchSession();
  try {
    await ext.signIn(second.context, email);
    const page = await ext.openGithub(second.context);
    expect(await ext.firstMountedKey(page), "a GitHub Emojery host should mount after reinstall").not.toBeNull();
    // The fresh profile has no local state, so seeing the pick again proves
    // identity follows the email.
    await expect
      .poll(
        async () => {
          if (await ext.hasOwnReaction(page)) return true;
          await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
          await page.waitForTimeout(2_000);
          return ext.hasOwnReaction(page);
        },
        { message: "the reaction made before the reinstall should be selected again", timeout: 60_000, intervals: [3_000] },
      )
      .toBe(true);
    expect(await ext.isReactionChecked(page, ext.REACTIONS.heart), "the SAME emoji should be highlighted after recovery").toBe(true);
    const history = await historyState(second.context, "github.com");
    expect(history.empty, "history is local: a fresh profile starts empty even for a recovered account").toBe(true);

    await ext.clearReaction(page);
  } finally {
    await ext.ensureSignedOut(second.context).catch(() => {});
    await ext.closeSession(second);
  }
});

// Repeated wrong codes switch the visible error from "incorrect code" to
// authErrTooManyTries. Its own address, so the accounts other tests sign in with
// are untouched.
test("repeated wrong OTP codes stop verification", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  test.setTimeout(Number(process.env.E2E_WRONG_CODE_TEST_TIMEOUT_MS ?? 240_000));
  const email = ext.authEmail("wrong-codes");
  const wrongCode = ext.wrongOtpFor(ext.authOtp());
  // Loop bound; the test fails if the error never switches within it. Configured
  // rather than defaulted in the tree. Unset => this case skips.
  const WRONG_CODE_BUDGET = Number(process.env.E2E_WRONG_CODE_ATTEMPTS);
  test.skip(!Number.isFinite(WRONG_CODE_BUDGET) || WRONG_CODE_BUDGET < 1, "Set E2E_WRONG_CODE_ATTEMPTS in .env.e2e.local (see .env.e2e.example) to run this check.");
  const session = await ext.launchSession();
  try {
    const extensionId = await ext.resolveExtensionId(session.context);
    expect(extensionId, "Emojery must be loaded before this check").not.toBeNull();
    if (!extensionId) return;
    const authPage = await session.context.newPage();
    await authPage.goto(ext.extensionPageUrl(extensionId, "auth.html"));
    await authPage.locator("#email-input").fill(email);
    await authPage.locator(".agree input[type=checkbox]").check();
    const sendBtn = authPage.getByRole("button", { name: "Send code" });
    await expect(sendBtn).toBeEnabled();
    await sendBtn.click();
    const codeInput = authPage.locator("#code-input");
    await expect(codeInput).toBeVisible();

    const invalidError = authPage.getByText(ext.enMessage("authErrCodeInvalid"), { exact: true });
    const tooManyError = authPage.getByText(ext.enMessage("authErrTooManyTries"), { exact: true });
    const signInBtn = authPage.getByRole("button", { name: "Sign in" });
    let stopped = false;
    for (let attempt = 1; attempt <= WRONG_CODE_BUDGET && !stopped; attempt += 1) {
      await codeInput.fill(wrongCode);
      await expect(signInBtn).toBeEnabled();
      await signInBtn.click();
      await expect(invalidError.or(tooManyError)).toBeVisible({ timeout: 20_000 });
      stopped = await tooManyError.isVisible().catch(() => false);
      await expect(codeInput).toBeVisible();
    }
    expect(stopped, "the error should switch to authErrTooManyTries within the wrong-code budget").toBe(true);

    await codeInput.fill(ext.authOtp());
    await expect(signInBtn).toBeEnabled();
    await signInBtn.click();
    await expect(tooManyError).toBeVisible({ timeout: 20_000 });
    await expect(authPage.getByRole("heading", { name: "You're signed in" })).toHaveCount(0);
    await authPage.close().catch(() => {});
  } finally {
    await ext.closeSession(session);
  }
});

// Two accounts on one target: each account's react/un-react moves the PUBLIC
// aggregate by exactly one, independently. Runs TWO parallel sessions (one
// browser profile per account) instead of switching accounts in one session:
// no sign-out ever happens, so no queued vote can be dropped and no flush
// sleeps are needed - each cross-account step is proven by polling the OTHER
// session's RENDERED counter, which only moves once the server took the vote.
test("two accounts raise and lower the shared counter independently", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  // Generous: two separate waits for the public count to settle.
  test.setTimeout(Number(process.env.E2E_TWO_ACCOUNT_TEST_TIMEOUT_MS ?? 600_000));
  const CACHE_WAIT = ext.COUNT_CACHE_WAIT_MS;
  const emailA = ext.authEmail("count-a");
  const emailB = ext.authEmail("count-b");
  // Launched sequentially INSIDE the try: with a parallel Promise.all outside it,
  // a throw from the second launch discards the first session's browser and its
  // run-* profile, leaking both for the rest of the run.
  let sessionA: ext.Session | undefined;
  let sessionB: ext.Session | undefined;
  let reactedAsA = false;
  let reactedAsB = false;
  try {
    sessionA = await ext.launchSession();
    sessionB = await ext.launchSession();
    await Promise.all([ext.signIn(sessionA.context, emailA), ext.signIn(sessionB.context, emailB)]);
    const pageA = await ext.openGithub(sessionA.context);
    const key = await ext.firstMountedKey(pageA);
    expect(key, "a GitHub Emojery host should mount").not.toBeNull();
    if (!key) return;
    // Settle the PUBLIC baseline before reacting: the rendered counter lags the
    // true total, so a single early read is stale and the absolute base+1/base+2
    // expectations below (including the COUNT_CACHE_WAIT_MS cross-session poll) can then never
    // converge. Same rendered-counter wait the deletion spec uses.
    const base = await ext.waitForSettledTotal(pageA);
    await ext.reactWith(pageA, ext.REACTIONS.heart);
    reactedAsA = true;
    await expect.poll(() => ext.hasOwnReaction(pageA)).toBe(true);
    await expect.poll(async () => (await ext.readCounter(pageA)).total ?? 0, { message: "account A's reaction should raise the counter by one" }).toBe(base + 1);

    // Account B observes A's vote purely through the public counter. Reaching
    // base+1 here also proves A's vote arrived server-side - A's session stays
    // open, so the queue flushes on its own schedule with nothing to race.
    const pageB = await ext.openGithub(sessionB.context);
    await expect
      .poll(async () => (await ext.reloadAndReadTotal(pageB)) ?? 0, {
        message: `the public counter should reach ${base + 1} (account A's vote) for account B`,
        timeout: CACHE_WAIT,
        intervals: [12_000],
      })
      .toBe(base + 1);
    expect(await ext.hasOwnReaction(pageB), "account B holds no reaction yet").toBe(false);

    await ext.reactWith(pageB, ext.REACTIONS.fire);
    reactedAsB = true;
    await expect.poll(() => ext.hasOwnReaction(pageB)).toBe(true);
    await expect.poll(async () => (await ext.readCounter(pageB)).total ?? 0, { message: "account B's reaction should raise the counter again" }).toBe(base + 2);

    await ext.clearReaction(pageB);
    reactedAsB = false;
    await expect.poll(() => ext.hasOwnReaction(pageB)).toBe(false);
    await expect.poll(async () => (await ext.readCounter(pageB)).total ?? 0, { message: "account B's un-react should lower the counter by one" }).toBe(base + 1);

    // A never signed out: a reload re-reads authoritative server state, so the
    // still-selected heart proves the reaction persisted across B's activity.
    await reloadAndSettle(pageA, 2_500);
    await expect.poll(() => ext.hasOwnReaction(pageA), { message: "account A's reaction should still be selected", timeout: 20_000 }).toBe(true);
    await ext.clearReaction(pageA);
    reactedAsA = false;
    await expect.poll(() => ext.hasOwnReaction(pageA)).toBe(false);
    // The optimistic layer only guarantees the OWN-reaction state; the public
    // count settles with a delay, so the baseline is readable only once it settles -
    // the same rendered-counter wait the deletion spec uses. Reaching base proves
    // BOTH un-reacts (B's session is still open behind this poll) hit the server.
    await expect
      .poll(async () => (await ext.reloadAndReadTotal(pageA)) ?? 0, {
        message: "after both un-reacts the counter should return to baseline",
        timeout: CACHE_WAIT,
        intervals: [12_000],
      })
      .toBe(base);
  } finally {
    // Best-effort: leave the shared staging target without this run's votes.
    // Each account's session is still signed in, so clear directly; the flush
    // wait matters here - closing the browser next would drop a queued un-react.
    const cleanup = async (session: ext.Session | undefined, reacted: boolean) => {
      if (!session) return;
      if (reacted) {
        await (async () => {
          const page = await ext.openGithub(session.context);
          await ext.clearReaction(page);
          await page.waitForTimeout(VOTE_FLUSH_MS);
        })().catch(() => {});
      }
      await ext.ensureSignedOut(session.context).catch(() => {});
      await ext.closeSession(session);
    };
    await Promise.all([cleanup(sessionA, reactedAsA), cleanup(sessionB, reactedAsB)]);
  }
});
