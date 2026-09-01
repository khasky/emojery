// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Settings tab's own logic - the part that is NOT "render a toggle": the
// per-site section's derived open state, the exclusion reset when it closes,
// the site filter, and the conditional sentiment editor. Rendered in a real
// engine (browser mode) because these are Preact components; the values they
// read (`settings`) and write (`update`) both arrive as props, so no storage.
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { ALL_SITES, DEFAULT_SITE_TOGGLES, SITE_LABELS } from "../../shared/sites";
import { DEFAULT_SETTINGS, type Settings } from "../../shared/storage";
import { mountContainer, requireEl, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim } from "../../test/chrome-shim";
import { SettingsView } from "./popup-settings";

let chromeShim: ChromeShimHandle;
let container: HTMLDivElement;
let update: Mock<(patch: Partial<Settings>) => Promise<void>>;

function mount(settings: Partial<Settings> = {}): void {
  const merged: Settings = { ...DEFAULT_SETTINGS, ...settings, sites: { ...DEFAULT_SETTINGS.sites, ...(settings.sites ?? {}) } };
  render(h(SettingsView, { settings: merged, update }), container);
}

/** The per-site rows, identified by the toggle each one carries. */
function siteToggles(): HTMLInputElement[] {
  return [...container.querySelectorAll<HTMLInputElement>("input.toggle[aria-label]")];
}

function generalToggle(label: string): HTMLInputElement {
  const row = [...container.querySelectorAll("label.row")].find((el) => el.querySelector(".row-label > span")?.textContent === label);
  const input = row?.querySelector<HTMLInputElement>("input.toggle");
  if (!input) throw new Error(`no general row labelled "${label}"`);
  return input;
}

beforeEach(() => {
  // The popup reads the active tab to point each per-site link at the right
  // regional storefront; an Amazon tab is the case where that actually varies.
  chromeShim = installChromeShim({ activeTab: { url: "https://www.amazon.de/dp/B00ZV9RDKK", id: 1 } });
  update = vi.fn(async () => {});
  container = mountContainer();
});

afterEach(() => {
  unmountContainer(container);
  chromeShim.uninstall();
});

describe("SettingsView - per-site section", () => {
  it("stays collapsed while every site is on", () => {
    mount();
    expect(siteToggles()).toHaveLength(0);
  });

  it("opens itself when a site is already off", () => {
    // Pins that a stored exclusion opens the section (rationale in popup-settings.tsx).
    mount({ sites: { ...DEFAULT_SITE_TOGGLES, github: false } });
    expect(siteToggles()).toHaveLength(ALL_SITES.length);
    const github = siteToggles().find((el) => el.getAttribute("aria-label")?.includes(SITE_LABELS.github));
    expect(github?.checked).toBe(false);
  });

  it("re-enables every site when the section is switched off", async () => {
    // Otherwise the collapsed row claims "on everywhere" while a site stays
    // silently off - the state the user can no longer see or reach.
    mount({ sites: { ...DEFAULT_SITE_TOGGLES, github: false } });
    await userEvent.click(generalToggle("Only selected sites"));
    expect(update).toHaveBeenCalledWith({ sites: DEFAULT_SITE_TOGGLES });
  });

  it("filters the site list by label, case-insensitively", async () => {
    mount({ sites: { ...DEFAULT_SITE_TOGGLES, github: false } });
    const filter = requireEl<HTMLInputElement>(container, "input.settings-filter-input");

    await userEvent.fill(filter, "git");
    const labels = siteToggles().map((el) => el.getAttribute("aria-label"));
    // GitHub and GitLab both match; nothing else does.
    expect(labels).toHaveLength(2);
    expect(labels.join(" ")).toContain(SITE_LABELS.github);
    expect(labels.join(" ")).toContain(SITE_LABELS.gitlab);

    await userEvent.fill(filter, "nothing-matches-this");
    expect(siteToggles()).toHaveLength(0);
  });

  it("points a site's link at the active tab's own storefront", async () => {
    mount({ sites: { ...DEFAULT_SITE_TOGGLES, github: false } });
    // The active tab arrives from an effect, so the first render still carries
    // the locale-derived default; the regional swap is what this pins.
    const amazonHref = () => [...container.querySelectorAll<HTMLAnchorElement>("a[href]")].find((a) => a.textContent === SITE_LABELS.amazon)?.href;
    await vi.waitFor(() => expect(amazonHref()).toContain("www.amazon.de"));
  });
});

describe("SettingsView - auto-press", () => {
  it("shows the emoji sentiment editor only while auto-press is on", async () => {
    mount({ autoTriggerNative: false });
    expect(container.querySelector(".sentiment-editor")).toBeNull();

    render(null, container);
    mount({ autoTriggerNative: true });
    expect(container.querySelector(".sentiment-editor")).not.toBeNull();
  });

  it("writes the toggled value through `update`", async () => {
    mount({ reactionAnimations: true });
    await userEvent.click(generalToggle("Reaction animations"));
    expect(update).toHaveBeenCalledWith({ reactionAnimations: false });
  });
});
