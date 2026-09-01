// SPDX-License-Identifier: GPL-3.0-or-later
//
// Profile-persistence coverage that needs a full browser restart:
// settings and reactions across relaunches of the same persistent Chrome profile
// (userDataDir) - something only the autonomous CDP runner can do. Verification
// is VISUAL: the popup's own toggle state and the shadow-hosted reaction trigger.

import { expect, test } from "@playwright/test";
import * as ext from "./lib/extension";
import { reloadAndSettle } from "./lib/reload-settle";

const REQUIRES_OTP = ext.otpSkipReason("authed persistence checks");

// Whole file signs in / toggles settings through the extension's own pages, which Playwright Firefox cannot reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);

// Each case below makes its own "persist" profile dir and removes it itself: the dir is
// reused across the two launches of one restart case, so closeSession is called with
// keepDir and cannot be the one to clean up. The removal honors E2E_KEEP_PROFILE=1 like
// every other suite - these are the restart cases whose failures most need the profile
// for a post-mortem.

// storage.sync persists in the profile, so a changed setting survives a full close + reopen.
test("settings: changed values survive a full browser restart", async () => {
  const dir = await ext.makeRunProfileDir("persist");
  try {
    const first = await ext.launchSession({ userDataDir: dir });
    try {
      await ext.setPopupCheckbox(first.context, {
        tab: "Settings",
        name: "Hide original buttons",
        checked: true,
      });
    } finally {
      await ext.closeSession(first, { keepDir: true });
    }

    const second = await ext.launchSession({ userDataDir: dir });
    try {
      const popup = await ext.openPopup(second.context);
      try {
        await popup.getByRole("tab", { name: "Settings" }).click();
        await expect(popup.getByRole("checkbox", { name: "Hide original buttons" })).toBeChecked();
      } finally {
        await popup.close().catch(() => {});
      }
    } finally {
      await ext.closeSession(second, { keepDir: true });
    }
  } finally {
    await ext.removeProfileUnlessKept(dir);
  }
});

// A reaction made before a full browser restart is still the user's reaction
// afterwards: it persisted SERVER-SIDE, not just in a local cache.
//
// Caveat on "still signed in": --load-extension re-fires onInstalled("install")
// on every launch, and the extension deliberately clears the local session
// (installFreshInstallAuthReset). That is a HARNESS artifact - a store-installed
// extension does NOT re-install on a restart and keeps you signed in. So
// session 2 re-signs in, then verifies the pre-restart reaction is intact.
test("a reaction survives a full browser restart", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const dir = await ext.makeRunProfileDir("persist");
  try {
    let targetKey: string | null = null;
    const first = await ext.launchSession({ userDataDir: dir });
    try {
      await ext.signIn(first.context);
      const page = await ext.openGithub(first.context);
      targetKey = await ext.firstMountedKey(page);
      expect(targetKey, "a GitHub Emojery host should mount").not.toBeNull();
      if (targetKey) {
        await ext.clearReaction(page);
        await ext.reactWith(page, ext.REACTIONS.heart);
        await expect.poll(() => ext.hasOwnReaction(page)).toBe(true);
        // Let the background queue POST the vote to the server, then confirm it
        // persisted (survives a reload) BEFORE we close - otherwise the restart
        // would read authoritative server state that never received the vote.
        await page.waitForTimeout(2_500);
        await reloadAndSettle(page, 2_500);
        await expect
          .poll(() => ext.hasOwnReaction(page), {
            message: "the reaction should persist server-side before restart",
            timeout: 20_000,
          })
          .toBe(true);
      }
    } finally {
      await ext.closeSession(first, { keepDir: true });
    }
    if (!targetKey) return;

    const second = await ext.launchSession({ userDataDir: dir });
    try {
      // Re-sign in: --load-extension re-install cleared the local session (see the
      // caveat above). The reaction itself lives on the server, independent of it.
      await ext.signIn(second.context);
      const page = await ext.openGithub(second.context);
      await expect
        .poll(() => ext.hasOwnReaction(page), {
          message: "the pre-restart reaction should still be the user's reaction",
          timeout: 20_000,
        })
        .toBe(true);
    } finally {
      await ext.ensureSignedOut(second.context).catch(() => {});
      await ext.closeSession(second, { keepDir: true });
    }
  } finally {
    await ext.removeProfileUnlessKept(dir);
  }
});

// Caveat: this models "first install on a clean profile". A true
// uninstall/reinstall on a Chrome profile signed into Chrome Sync can restore
// synced settings instead - a mechanism --load-extension can't reproduce; that
// edge stays a manual check.
test("a fresh profile starts with default settings", async () => {
  const session = await ext.launchSession();
  try {
    const popup = await ext.openPopup(session.context);
    try {
      await popup.getByRole("tab", { name: "Settings" }).click();
      await expect(popup.getByRole("checkbox", { name: "Enabled" })).toBeChecked();
      await expect(popup.getByRole("checkbox", { name: "Hide original buttons" })).not.toBeChecked();
      await expect(popup.getByRole("checkbox", { name: "Reaction animations" })).toBeChecked();
    } finally {
      await popup.close().catch(() => {});
    }
  } finally {
    await ext.closeSession(session);
  }
});

// analyticsConsent (authed-only, Account tab) is a synced setting: turning it
// OFF must survive a full browser restart. The local session is cleared by the
// --load-extension re-install (see the caveat above), so session 2 re-signs in
// to reveal the still-persisted toggle.
test("analytics consent survives a full browser restart", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const consentLabel = ext.enMessage("settingAnalyticsConsent");
  const dir = await ext.makeRunProfileDir("persist");
  try {
    const first = await ext.launchSession({ userDataDir: dir });
    try {
      await ext.signIn(first.context);
      await ext.setPopupCheckbox(first.context, {
        tab: "Account",
        name: consentLabel,
        checked: false,
      });
    } finally {
      await ext.closeSession(first, { keepDir: true });
    }

    const second = await ext.launchSession({ userDataDir: dir });
    try {
      await ext.signIn(second.context);
      const popup = await ext.openPopup(second.context);
      try {
        await popup.getByRole("tab", { name: "Account" }).click();
        await expect(popup.getByRole("checkbox", { name: consentLabel })).not.toBeChecked();
      } finally {
        await popup.close().catch(() => {});
      }
    } finally {
      await ext.ensureSignedOut(second.context).catch(() => {});
      await ext.closeSession(second, { keepDir: true });
    }
  } finally {
    await ext.removeProfileUnlessKept(dir);
  }
});
