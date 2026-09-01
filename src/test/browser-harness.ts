// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared core for the *.browser.test.tsx suites: the query-or-throw lookup and the
// render-then-wait mount step. Each suite keeps its own install() - the mock contracts
// differ per view, and unifying them would blur what each test actually arranges.
import { type ComponentChild, render } from "preact";
import { expect, vi } from "vitest";

/** Fresh render target on <body>. Paired with `unmountContainer` - creating one
 *  without the matching teardown leaves the preact tree (and its effect cleanups)
 *  subscribed for the rest of the file. Not a `beforeEach` hook on purpose: the
 *  suites install their chrome shim in the same block and the order matters. */
export function mountContainer(): HTMLDivElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  return container;
}

/** The other half of `mountContainer`: unmount, then drop the node. */
export function unmountContainer(container: HTMLElement): void {
  render(null, container);
  container.remove();
}

/** Query-or-throw: a missing element is a broken arrangement, not an assertion subject. */
export function requireEl<T extends Element>(root: ParentNode, selector: string): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`not rendered: ${selector}`);
  return el;
}

/** Render into `container` and wait until `settledSelector` matches - the view's
 *  own "no longer loading" shape, chosen per suite. */
export async function renderAndSettle(container: HTMLElement, vnode: ComponentChild, settledSelector: string): Promise<void> {
  render(vnode, container);
  await vi.waitFor(() => expect(container.querySelector(settledSelector)).not.toBeNull());
}
