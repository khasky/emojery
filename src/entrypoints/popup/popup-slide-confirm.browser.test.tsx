// SPDX-License-Identifier: GPL-3.0-or-later
//
// Slide-to-confirm mechanics (the deliberate-input gate before account
// deletion): ARIA-slider keyboard steps, End/Home jumps, the step-click
// fallback (WCAG 2.5.7), and that a lone tap on the thumb can never confirm.
// The 3s step-click spring-back timer is deliberately untested (wall-clock).
import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { mountContainer, requireEl, unmountContainer } from "../../test/browser-harness";
import { type ChromeShimHandle, installChromeShim } from "../../test/chrome-shim";
import { SlideToConfirm } from "./popup-slide-confirm";
// The pointer paths are geometry: without the real track/thumb layout the
// thumb spans the whole track and every click reads as a drag on it. The app
// links popup.css from index.html, so no *.css module declaration exists.
// @ts-expect-error side-effect css import, resolved by the browser-mode Vite server
import "./popup.css";

let chromeShim: ChromeShimHandle;
let container: HTMLDivElement;
let onConfirm: Mock<() => void>;

function mount(): void {
  render(h(SlideToConfirm, { label: "Slide to delete", onConfirm }), container);
}

const thumb = (): HTMLElement => requireEl(container, '[role="slider"]');

const valueNow = () => Number(thumb().getAttribute("aria-valuenow"));

beforeEach(() => {
  chromeShim = installChromeShim();
  onConfirm = vi.fn();
  container = mountContainer();
  mount();
});

afterEach(() => {
  unmountContainer(container);
  chromeShim.uninstall();
});

describe("SlideToConfirm", () => {
  it("advances 10% per ArrowRight and confirms exactly once at the threshold", async () => {
    thumb().focus();
    // 9 steps read 90% but sit just UNDER the 0.9 threshold (0.1 accumulates
    // to 0.8999...); the tenth press lands. Pinned so a rounding "fix" that
    // makes the ninth press delete an account shows up here.
    for (let i = 0; i < 9; i++) await userEvent.keyboard("{ArrowRight}");
    expect(valueNow()).toBe(90);
    expect(onConfirm).not.toHaveBeenCalled();

    await userEvent.keyboard("{ArrowRight}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(valueNow()).toBe(100);
    expect(thumb().getAttribute("aria-disabled")).toBe("true");

    // Landed control ignores further input.
    await userEvent.keyboard("{ArrowRight}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("End confirms immediately; Home and ArrowLeft never go below zero", async () => {
    thumb().focus();
    await userEvent.keyboard("{ArrowLeft}");
    expect(valueNow()).toBe(0);
    await userEvent.keyboard("{ArrowRight}{ArrowRight}{Home}");
    expect(valueNow()).toBe(0);
    await userEvent.keyboard("{End}");
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("track clicks step a quarter of the travel each and confirm on the fourth", async () => {
    const track = requireEl<HTMLElement>(container, ".slide-confirm");
    // Click the track's right edge - away from the thumb, which sits left.
    const rightEdge = () => userEvent.click(track, { position: { x: track.getBoundingClientRect().width - 6, y: track.getBoundingClientRect().height / 2 } });
    await rightEdge();
    expect(valueNow()).toBe(25);
    await rightEdge();
    await rightEdge();
    expect(valueNow()).toBe(75);
    expect(onConfirm).not.toHaveBeenCalled();
    await rightEdge();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("a lone tap on the thumb itself never advances or confirms", async () => {
    await userEvent.click(thumb());
    expect(valueNow()).toBe(0);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
