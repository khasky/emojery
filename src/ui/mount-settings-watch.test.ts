// SPDX-License-Identifier: GPL-3.0-or-later
//
// watchSettings applies popup toggles to already-mounted triggers live (no page
// reload): an enable/site flip tears mounts down, replaceNative off restores
// the natives it hid, a reactionAnimations flip re-stamps the animate attribute.
// Sentinels only - no supported-site DOM is simulated (placement is e2e's job).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SiteAdapter } from "../shared/adapter";
import { HOST_CLASS } from "../shared/dom";
import type { TargetKey } from "../shared/storage";
import { DEFAULT_SETTINGS, type Settings } from "../shared/storage";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { tk } from "../test/target-key";
import { watchSettings } from "./mount";
import { mountedCount, registerMountNode, resetMountRegistryForTests } from "./mount-registry";
import { registerThemedHost } from "./themed-hosts";

const ANIMATE_ATTR = "data-khasky-emojery-animate";

const adapter = {
  site: "github",
  matches: () => true,
  scan: () => [],
  observe: () => {},
} as unknown as SiteAdapter;

function settingsWith(patch: Partial<Settings>): Settings {
  return { ...DEFAULT_SETTINGS, ...patch, sites: { ...DEFAULT_SETTINGS.sites } };
}

function emitSettingsChange(shim: ChromeShimHandle, oldValue: Settings, newValue: Settings): void {
  shim.emitChanged("sync", { settings: { oldValue, newValue } });
}

function seedMountedHost(key: TargetKey): HTMLElement {
  const host = document.createElement("span");
  host.className = HOST_CLASS;
  document.body.appendChild(host);
  registerMountNode(key, host);
  return host;
}

describe("watchSettings", () => {
  // One shim + one watcher for the whole suite: watchSettings installs its
  // storage listener once per module, on the shim active at first call.
  let shim: ChromeShimHandle;

  beforeAll(() => {
    shim = installChromeShim();
    watchSettings(adapter);
  });

  afterAll(() => shim.uninstall());

  afterEach(() => {
    resetMountRegistryForTests();
  });

  it("re-stamps the animate attribute on mounted hosts when reactionAnimations flips", () => {
    const host = seedMountedHost(tk("github:animate"));
    host.setAttribute(ANIMATE_ATTR, "");

    emitSettingsChange(shim, settingsWith({ reactionAnimations: true }), settingsWith({ reactionAnimations: false }));
    expect(host.hasAttribute(ANIMATE_ATTR)).toBe(false);

    // Synchronous only on the no-IntersectionObserver fallback branch of
    // setRingAnimation, which is what jsdom gives us; the observer path (spin
    // while on screen) is covered by e2e.
    emitSettingsChange(shim, settingsWith({ reactionAnimations: false }), settingsWith({ reactionAnimations: true }));
    expect(host.hasAttribute(ANIMATE_ATTR)).toBe(true);
  });

  it("restores hidden natives when replaceNative flips off", () => {
    const native = document.createElement("button");
    native.dataset.khaskyEmojeryHidden = "1";
    native.style.setProperty("display", "none", "important");
    document.body.appendChild(native);

    emitSettingsChange(shim, settingsWith({ replaceNative: true }), settingsWith({ replaceNative: false }));

    expect(native.dataset.khaskyEmojeryHidden).toBeUndefined();
    expect(native.style.display).toBe("");
  });

  it("re-stamps mounted hosts when the Theme setting forces a palette", () => {
    const host = seedMountedHost(tk("github:theme"));
    registerThemedHost(host);
    expect(host.getAttribute("data-theme")).toBe("light");

    emitSettingsChange(shim, settingsWith({}), settingsWith({ theme: "dark" }));
    expect(host.getAttribute("data-theme")).toBe("dark");

    // Back to "system": the bare jsdom document detects light again.
    emitSettingsChange(shim, settingsWith({ theme: "dark" }), settingsWith({}));
    expect(host.getAttribute("data-theme")).toBe("light");
  });

  it("tears mounts down when the extension is disabled", () => {
    const host = seedMountedHost(tk("github:disable"));

    emitSettingsChange(shim, settingsWith({ enabled: true }), settingsWith({ enabled: false }));

    expect(host.isConnected).toBe(false);
    expect(mountedCount()).toBe(0);
  });
});
