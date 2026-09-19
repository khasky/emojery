// SPDX-License-Identifier: GPL-3.0-or-later
//
// Settings belong to the account, not to the browser: two accounts on one device
// keep their own, and a setting nobody moved stays the default for everyone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome } from "../test/fixtures";
import { ACTIVE_ACCOUNT_KEY, activateAccountSettings, changedFromDefaults, DEFAULT_SETTINGS, getSettings, SETTINGS_BY_ACCOUNT_KEY, SETTINGS_KEY, SIGNED_OUT_ACCOUNT, setSettings, settingsForAccount } from "./storage";

let local: Record<string, unknown>;
let sync: Record<string, unknown>;

function install(initial: { local?: Record<string, unknown>; sync?: Record<string, unknown> } = {}): void {
  const fake = installFakeChrome({ local: initial.local ?? {}, sync: initial.sync ?? {} });
  local = fake.local;
  sync = fake.sync;
}

beforeEach(() => {
  install();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("changedFromDefaults", () => {
  it("keeps only what moved", () => {
    expect(changedFromDefaults(DEFAULT_SETTINGS)).toEqual({});
    expect(changedFromDefaults({ ...DEFAULT_SETTINGS, enabled: false })).toEqual({ enabled: false });
  });

  // A record of every setting would make the defaults a snapshot of the day the
  // account was made: change a default later and that account would never see it.
  it("does not record a setting that merely equals its default", () => {
    expect(changedFromDefaults({ ...DEFAULT_SETTINGS, theme: DEFAULT_SETTINGS.theme })).toEqual({});
  });
});

describe("settings that follow the account", () => {
  it("writes what changed under the account that changed it", async () => {
    await activateAccountSettings("u_1");
    await setSettings({ enabled: false });

    expect(local[SETTINGS_BY_ACCOUNT_KEY]).toEqual({ u_1: { enabled: false } });
    expect((await getSettings()).enabled).toBe(false);
  });

  it("gives each account its own, and switching swaps them", async () => {
    await activateAccountSettings("u_1");
    await setSettings({ enabled: false, reactionAnimations: false });
    await activateAccountSettings("u_2");
    await setSettings({ theme: "dark" });

    expect(await settingsForAccount("u_1")).toMatchObject({ enabled: false, reactionAnimations: false, theme: DEFAULT_SETTINGS.theme });
    expect(await settingsForAccount("u_2")).toMatchObject({ enabled: true, theme: "dark" });

    await activateAccountSettings("u_1");
    expect(await getSettings()).toMatchObject({ enabled: false, theme: DEFAULT_SETTINGS.theme });
  });

  // The point of storing only what changed: an account that never touched a setting
  // takes today's default, not the one in force when some other account was made.
  it("starts a new account on the defaults", async () => {
    await activateAccountSettings("u_1");
    await setSettings({ enabled: false });
    await activateAccountSettings("u_new");

    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("gives signed-out its own settings rather than the last account's", async () => {
    await activateAccountSettings("u_1");
    await setSettings({ enabled: false });
    await activateAccountSettings(SIGNED_OUT_ACCOUNT);

    expect((await getSettings()).enabled).toBe(true);
    await setSettings({ theme: "dark" });
    // And signing back in restores the account's, untouched by what happened while
    // nobody was signed in.
    await activateAccountSettings("u_1");
    expect(await getSettings()).toMatchObject({ enabled: false, theme: DEFAULT_SETTINGS.theme });
  });

  // storage.sync passes through the browser vendor's service, and what goes there is
  // a preferences blob naming nobody (docs/permissions.md). The per-account records
  // are keyed by account id, so they stay on the device.
  it("keeps the account ids out of synced storage", async () => {
    await activateAccountSettings("u_1");
    await setSettings({ enabled: false });

    expect(sync[SETTINGS_BY_ACCOUNT_KEY]).toBeUndefined();
    expect(JSON.stringify(sync)).not.toContain("u_1");
    expect(local[SETTINGS_BY_ACCOUNT_KEY]).toEqual({ u_1: { enabled: false } });
  });

  it("names the active account where a content script can read it without the session record", async () => {
    await activateAccountSettings("u_1");
    expect(local[ACTIVE_ACCOUNT_KEY]).toBe("u_1");
    await activateAccountSettings(SIGNED_OUT_ACCOUNT);
    expect(local[ACTIVE_ACCOUNT_KEY]).toBe(SIGNED_OUT_ACCOUNT);
  });

  // Every reader outside this module - the mount gate, the settings watcher, the
  // content script's cache - still reads one resolved object under one key.
  it("keeps the effective snapshot under the key every reader already watches", async () => {
    await activateAccountSettings("u_1");
    await setSettings({ enabled: false });
    expect(sync[SETTINGS_KEY]).toMatchObject({ enabled: false });
  });

  it("forgets an account's record once it is back on the defaults", async () => {
    await activateAccountSettings("u_1");
    await setSettings({ enabled: false });
    await setSettings({ enabled: true });
    expect(local[SETTINGS_BY_ACCOUNT_KEY]).toEqual({});
  });
});

describe("the move to per-account settings", () => {
  // Upgrading must not reset the settings of whoever is signed in at the time.
  it("carries what the device had to the account signed in when it ran", async () => {
    install({ local: { [ACTIVE_ACCOUNT_KEY]: "u_1" }, sync: { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, enabled: false, theme: "dark" } } });

    await setSettings({});

    expect(local[SETTINGS_BY_ACCOUNT_KEY]).toEqual({ u_1: { enabled: false, theme: "dark" } });
    expect(await getSettings()).toMatchObject({ enabled: false, theme: "dark" });
  });

  it("carries them across a sign-out, so signing back in finds them", async () => {
    install({ local: { [ACTIVE_ACCOUNT_KEY]: "u_1" }, sync: { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, enabled: false } } });

    await activateAccountSettings(SIGNED_OUT_ACCOUNT);
    expect((await getSettings()).enabled).toBe(true);

    await activateAccountSettings("u_1");
    expect((await getSettings()).enabled).toBe(false);
  });

  it("runs once, and does not re-carry a setting the account has since changed", async () => {
    install({ local: { [ACTIVE_ACCOUNT_KEY]: "u_1" }, sync: { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS, enabled: false } } });

    await setSettings({ enabled: true });
    await activateAccountSettings(SIGNED_OUT_ACCOUNT);
    await activateAccountSettings("u_1");

    expect((await getSettings()).enabled).toBe(true);
  });

  it("leaves a device that changed nothing with no records at all", async () => {
    install({ sync: { [SETTINGS_KEY]: { ...DEFAULT_SETTINGS } } });
    await activateAccountSettings("u_1");
    expect(local[SETTINGS_BY_ACCOUNT_KEY]).toEqual({});
  });
});
