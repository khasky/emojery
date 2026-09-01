// SPDX-License-Identifier: GPL-3.0-or-later
//
// Single-open invariant for the history hover tooltip: moving the pointer to a
// neighbouring row must drop the previous popup at once instead of waiting out
// its grace timer - overlapping popups used to stack up over the rows below.

import { h, render } from "preact";
import { afterEach, beforeEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { mountContainer, requireEl, unmountContainer } from "../../test/browser-harness";
import { HoverTooltip } from "./popup-tooltip";

let container: HTMLDivElement;

beforeEach(() => {
  container = mountContainer();
  render(h("div", null, [h(HoverTooltip, { variant: "text", wrapClass: "row-a", trigger: "A", content: () => "tip A" }), h(HoverTooltip, { variant: "text", wrapClass: "row-b", trigger: "B", content: () => "tip B" })]), container);
});

afterEach(() => {
  unmountContainer(container);
});

const trigger = (cls: string): HTMLElement => requireEl(container, `.${cls}`);

it("keeps at most one tooltip open across neighbouring triggers", async () => {
  await userEvent.hover(trigger("row-a"));
  expect(container.querySelectorAll(".tt-pop")).toHaveLength(1);

  await userEvent.hover(trigger("row-b"));
  const open = container.querySelectorAll(".tt-pop");
  expect(open).toHaveLength(1);
  expect(open[0]?.textContent).toBe("tip B");
  expect(trigger("row-a").querySelector(".tt-pop")).toBeNull();
});
