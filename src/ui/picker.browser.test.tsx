// SPDX-License-Identifier: GPL-3.0-or-later
//
// Render tests for the reaction Picker in a REAL WebKit engine (Vitest browser mode ->
// Playwright WebKit): real DOM, real layout (getBoundingClientRect returns true boxes,
// unlike jsdom's zeros), real event dispatch, real Preact portal - all against the faked
// extension runtime from src/test/chrome-shim.ts.

import { h, render } from "preact";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { HOST_CLASS, LAYOUT_ATTR } from "../shared/dom";
import { CATEGORIES, REACTIONS } from "../shared/reactions";
import { type ChromeShimHandle, installChromeShim } from "../test/chrome-shim";
import { tk } from "../test/target-key";
import { mountedNode, pruneDisconnected, registerMountNode, removeMountNode, resetMountRegistryForTests } from "./mount-registry";
import { PICKER_STYLESHEET } from "./mount-shadow";
import { applyPageTypography } from "./mount-style";
import { Picker } from "./picker";

let chromeShim: ChromeShimHandle;
let container: HTMLDivElement;
let portalRoot: HTMLDivElement;
let styleEl: HTMLStyleElement;

// The zero-count initial state most cases start from; only the auth flag varies.
function emptyInitial(isAuthed = true) {
  return { value: { counts: {}, total: 0, loaded: 0, hasMore: false }, myReaction: null, isAuthed };
}

function mountPicker(): void {
  render(
    h(Picker, {
      initial: emptyInitial(),
      onPick: () => true,
      onSignIn: () => {},
      portalRoot,
    }),
    container,
  );
}

type RefreshPush = (next: { value?: { counts: Record<string, number>; total: number; loaded: number; hasMore: boolean }; myReaction: string | null; authed?: boolean }) => void;

function mountSignedOutPicker(onSignIn: () => void, opts: { autoOpen?: boolean; captureRefresh?: (cb: RefreshPush) => void; onPick?: (reaction: string | null) => boolean } = {}): void {
  render(
    h(Picker, {
      initial: emptyInitial(false),
      onPick: opts.onPick ?? (() => true),
      onSignIn,
      ...(opts.autoOpen ? { autoOpen: true } : {}),
      ...(opts.captureRefresh ? { bindRefresh: opts.captureRefresh } : {}),
      portalRoot,
    }),
    container,
  );
}

// Opens a signed-out picker and clicks the first palette emoji, i.e. walks the whole
// pre-auth path the gate now sits at the end of. Returns the emoji that was chosen.
async function pickWhileSignedOut(): Promise<string> {
  await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
  const item = await pollForElement(() => portalRoot.querySelector<HTMLButtonElement>(".khasky-emojery-grid-item"));
  const emoji = item.textContent!.trim();
  await userEvent.click(item);
  return emoji;
}

function mountCounterPicker(): void {
  render(
    h(Picker, {
      initial: {
        value: { counts: { "🔥": 2, "❤️": 1 }, total: 3, loaded: 2, hasMore: false },
        myReaction: null,
        isAuthed: true,
      },
      onPick: () => true,
      onSignIn: () => {},
      portalRoot,
    }),
    container,
  );
}

beforeEach(() => {
  chromeShim = installChromeShim();
  container = document.createElement("div");
  portalRoot = document.createElement("div");
  document.body.append(container, portalRoot);
  // Load the shipped picker stylesheet so the popover gets its real geometry
  // (`position: fixed; width: 18em`) - the layout tests assert on it. The rules
  // are class-based (not `:host`-scoped), so they apply in this light-DOM render.
  styleEl = document.createElement("style");
  styleEl.textContent = PICKER_STYLESHEET;
  document.head.appendChild(styleEl);
});

afterEach(() => {
  render(null, container);
  container.remove();
  portalRoot.remove();
  styleEl.remove();
  chromeShim.uninstall();
  resetMountRegistryForTests();
});

describe("Picker - WebKit render", () => {
  it("renders an interactive trigger with a real layout box", async () => {
    mountPicker();

    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger");
    expect(trigger, "idle trigger should render").not.toBeNull();

    const rect = trigger!.getBoundingClientRect();
    expect(rect.width).toBeGreaterThan(0);
    expect(rect.height).toBeGreaterThan(0);

    expect(trigger!.getAttribute("aria-haspopup")).toBe("dialog");
    expect(trigger!.getAttribute("aria-expanded")).toBe("false");
  });

  // A cache-missing mount renders the empty trigger and fetches counts in the
  // background (mount-counts.ts hydrateDeferredCounts). If the user clicks before
  // that lands, the hydration must fill the counter WITHOUT closing the popover
  // they just opened - otherwise an early click looks like the picker refusing to open.
  it("keeps the popover open when deferred counts hydrate under it", async () => {
    let pushRefresh: ((next: { value?: { counts: Record<string, number>; total: number; loaded: number; hasMore: boolean }; myReaction: string | null; authed?: boolean }) => void) | null = null;
    render(
      h(Picker, {
        initial: emptyInitial(),
        onPick: () => true,
        onSignIn: () => {},
        portalRoot,
        bindRefresh: (cb) => {
          pushRefresh = cb;
        },
      }),
      container,
    );

    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    await userEvent.click(trigger);
    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).not.toBeNull();

    const push = pushRefresh as unknown as (next: { value: { counts: Record<string, number>; total: number; loaded: number; hasMore: boolean }; myReaction: string | null; authed: boolean }) => void;
    expect(push, "the picker must expose its refresh callback").toBeTruthy();
    push({
      value: { counts: { "🔥": 12, "❤️": 8 }, total: 20, loaded: 2, hasMore: false },
      myReaction: null,
      authed: true,
    });

    await expect.poll(() => container.querySelector(".khasky-emojery-counter")).not.toBeNull();
    expect(portalRoot.querySelector('[role="dialog"]'), "count hydration must not close an open popover").not.toBeNull();
    expect(container.querySelector(".khasky-emojery-counter")!.getAttribute("aria-expanded")).toBe("true");
  });

  it("opens the picker popover into the portal on click", async () => {
    mountPicker();

    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    await userEvent.click(trigger);

    // The popover renders via createPortal into portalRoot (outside the page's
    // transformed ancestors), not inside `container`.
    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    expect(portalRoot.querySelector(".khasky-emojery-search")).not.toBeNull();
    expect(portalRoot.querySelectorAll(".khasky-emojery-grid-item").length).toBeGreaterThan(0);
  });

  // Trusted-gesture gate, see picker.tsx handlePick: a synthetic click must neither
  // open the picker nor cast a reaction.
  it("ignores synthetic clicks and votes only on a real user gesture", async () => {
    const picked: (string | null)[] = [];
    render(
      h(Picker, {
        initial: emptyInitial(),
        onPick: (reaction: string | null) => {
          picked.push(reaction);
          return true;
        },
        onSignIn: () => {},
        portalRoot,
      }),
      container,
    );

    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    trigger.click();
    expect(portalRoot.querySelector('[role="dialog"]'), "a synthetic click must not open the picker").toBeNull();

    await userEvent.click(trigger);
    const item = await pollForElement(() => portalRoot.querySelector<HTMLButtonElement>(".khasky-emojery-grid-item"));

    // Opened for real, but the pick itself is synthetic - still no vote.
    item.click();
    expect(picked, "a synthetic click must not cast a reaction").toEqual([]);

    await userEvent.click(item);
    await expect.poll(() => picked.length).toBe(1);
  });

  it("filters the grid as the user searches", async () => {
    mountPicker();

    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
    const search = await pollForElement(() => portalRoot.querySelector<HTMLInputElement>(".khasky-emojery-search"));

    await userEvent.fill(search, "fire");

    // 🔥's English label is "fire" (bundled emojibase fallback), so at least one
    // grid option surfaces and the no-matches empty state is absent.
    await expect.poll(() => Array.from(portalRoot.querySelectorAll<HTMLElement>(".khasky-emojery-grid-item")).some((el) => (el.getAttribute("aria-label") ?? "").toLowerCase().includes("fire"))).toBe(true);
    expect(portalRoot.querySelector(".khasky-emojery-empty")).toBeNull();
  });

  // The gradient ring is a rendered element inside the trigger, so it sits in the same
  // child list the counter's emoji stack is styled through, and it overlays the whole
  // button. Both are load-bearing: a ring placed first would shift `> span:first-child` /
  // `> span:nth-child(n + 2)` onto the wrong emoji, and a ring that took pointer events
  // would swallow every click on the trigger.
  it("keeps the ring clear of the counter's emoji stack and of its clicks", async () => {
    mountCounterPicker();

    const emojis = container.querySelector<HTMLElement>(".khasky-emojery-counter-emojis")!;
    expect(emojis.firstElementChild?.tagName).toBe("SPAN");
    expect(emojis.lastElementChild?.classList.contains("khasky-emojery-ring")).toBe(true);

    // Exactly one ring paints per trigger: the button's own in the default horizontal form.
    const rings = Array.from(container.querySelectorAll<HTMLElement>(".khasky-emojery-ring"));
    expect(rings.length).toBe(2);
    expect(rings.filter((r) => getComputedStyle(r).display !== "none").length).toBe(1);

    const counter = container.querySelector<HTMLButtonElement>(".khasky-emojery-counter")!;
    await userEvent.click(counter);
    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).not.toBeNull();
  });

  // A feed recycles cards under an open picker; the mount node is then dropped mid-flight.
  // removeMountNode has to tear the preact tree down first, or the popover's document-level
  // listeners (and its portal content) outlive the trigger that owned them.
  it("tears the picker down when its mount node is removed with the popover open", async () => {
    const host = document.createElement("span");
    host.className = HOST_CLASS;
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    render(h(Picker, { initial: emptyInitial(), onPick: () => true, onSignIn: () => {}, portalRoot }), shadow);
    await userEvent.click(shadow.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).not.toBeNull();

    removeMountNode(host);

    expect(host.isConnected).toBe(false);
    // The portal is preact-owned: it only empties if the tree was unmounted, which is also
    // what runs the effect cleanups that remove the document/window listeners.
    expect(portalRoot.querySelector('[role="dialog"]')).toBeNull();
  });

  // The same teardown reached the other way round: a virtualized feed detaches the card
  // itself, so nothing calls removeMountNode and only the prune walk is left to notice.
  // Forgetting the registry entries there is half a teardown - it leaves one live picker
  // per recycled card, still subscribed to locale changes and still holding its listeners.
  it("tears the picker down when the SITE detached the mount node", async () => {
    const host = document.createElement("span");
    host.className = HOST_CLASS;
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    render(h(Picker, { initial: emptyInitial(), onPick: () => true, onSignIn: () => {}, portalRoot }), shadow);
    await userEvent.click(shadow.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).not.toBeNull();

    registerMountNode(tk("x:recycled-card"), host);
    host.remove();
    pruneDisconnected();

    expect(mountedNode(tk("x:recycled-card"))).toBeUndefined();
    expect(portalRoot.querySelector('[role="dialog"]')).toBeNull();
  });

  // The icon-column (reel/shorts rail) form moves the ring from the button onto the round
  // icon. Both halves of that swap live in `:host([data-khasky-emojery-layout="icon-column"])`
  // rules, so this is the one case that needs a real shadow root to resolve.
  it("moves the ring onto the round icon in the icon-column form", () => {
    const host = document.createElement("span");
    host.setAttribute(LAYOUT_ATTR, "icon-column");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const shadowStyle = document.createElement("style");
    shadowStyle.textContent = PICKER_STYLESHEET;
    shadow.appendChild(shadowStyle);

    try {
      render(h(Picker, { initial: emptyInitial(), onPick: () => true, onSignIn: () => {}, portalRoot }), shadow);

      const buttonRing = shadow.querySelector<HTMLElement>(".khasky-emojery-trigger > .khasky-emojery-ring")!;
      const iconRing = shadow.querySelector<HTMLElement>(".khasky-emojery-trigger-icon > .khasky-emojery-ring")!;
      expect(getComputedStyle(buttonRing).display).toBe("none");
      expect(getComputedStyle(iconRing).display).not.toBe("none");
      // It takes the circle's shape, and covers it: a ring smaller than its icon reads as a
      // misaligned blob rather than a border.
      const icon = shadow.querySelector<HTMLElement>(".khasky-emojery-trigger-icon")!;
      expect(getComputedStyle(iconRing).borderRadius).toBe(getComputedStyle(icon).borderRadius);
      expect(iconRing.getBoundingClientRect().width).toBeCloseTo(icon.getBoundingClientRect().width, 0);
    } finally {
      render(null, shadow);
      host.remove();
    }
  });

  // The font bounds live ONLY in picker.css: mount-style stamps the page's MEASURED size
  // and the `:host` clamp resolves it. Needs a real engine (jsdom does not compute clamp).
  // A bound re-introduced in TS, or a stamp under the wrong property, surfaces here.
  it("clamps the stamped page font size to the stylesheet's bounds", () => {
    const host = document.createElement("span");
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });
    const shadowStyle = document.createElement("style");
    shadowStyle.textContent = PICKER_STYLESHEET;
    shadow.appendChild(shadowStyle);

    try {
      for (const [pageFont, resolved] of [
        ["40px", "18px"],
        ["10px", "14px"],
        ["16px", "16px"],
      ] as const) {
        applyPageTypography(host, { fontSize: pageFont });
        expect(getComputedStyle(host).fontSize, `page font ${pageFont}`).toBe(resolved);
      }
    } finally {
      host.remove();
    }
  });
});

describe("Picker - WebKit layout (real geometry)", () => {
  it("positions the open popover inside the viewport, not the off-screen sentinel", async () => {
    mountPicker();
    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    await userEvent.click(trigger);

    const popover = await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-popover"));
    await expect.poll(() => popover.style.visibility).toBe("visible");
    const top = Number.parseFloat(popover.style.top);
    const left = Number.parseFloat(popover.style.left);
    expect(Number.isFinite(top)).toBe(true);
    expect(top).toBeGreaterThan(-9000); // the -9999px pre-measure sentinel is gone
    expect(top).toBeGreaterThanOrEqual(0);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it("clamps the popover so it never overflows the right viewport edge", async () => {
    // Park the trigger hard against the right edge; the popover must shift left
    // to stay on-screen (picker-hooks.ts usePopoverPosition: left = innerWidth - w - margin).
    container.style.cssText = "position: fixed; right: 0; top: 200px;";
    mountPicker();
    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    await userEvent.click(trigger);

    const popover = await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-popover"));
    await expect.poll(() => popover.style.visibility).toBe("visible");
    const left = Number.parseFloat(popover.style.left);
    expect(popover.offsetWidth).toBeGreaterThan(0);
    expect(left + popover.offsetWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("closes the popover on page scroll outside it", async () => {
    mountPicker();
    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    await userEvent.click(trigger);
    await pollForElement(() => portalRoot.querySelector('[role="dialog"]'));

    // A scroll outside the popover that moved the trigger dismisses it. Shift the trigger
    // (as a real scroll would), then dispatch on document - the capture listener sees it.
    container.style.marginTop = "40px";
    document.dispatchEvent(new Event("scroll"));

    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("survives a movement-free scroll event (sub-pixel snap jitter at fractional OS scaling)", async () => {
    mountPicker();
    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    await userEvent.click(trigger);
    await pollForElement(() => portalRoot.querySelector('[role="dialog"]'));

    // FB reels at 125% Windows scaling: the snap container re-aligns its fractional
    // offset right after the popover opens, firing scroll events although the trigger
    // stays put (< 1px). Those must not close the picker (open-then-instantly-close bug).
    document.dispatchEvent(new Event("scroll"));
    container.style.marginTop = "0.5px";
    document.dispatchEvent(new Event("scroll"));

    // A dismiss lands in the scroll handler or the next frame's state flush -
    // two rAFs bound the negative assert to the render loop, not wall time.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(portalRoot.querySelector('[role="dialog"]')).not.toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });
});

// Mirrored layout: when the popover can't open below it opens above, and the sticky head
// (search + nav) moves to the BOTTOM so the search box stays beside the button - without
// the mirror, a shrinking search result set left the search stranded at the far top.
describe("Picker - mirrored placement above the trigger", () => {
  it("opens below by default: sticky head pinned at the top, before the grid", async () => {
    mountPicker();
    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    await userEvent.click(trigger);
    const popover = await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-popover"));
    await expect.poll(() => popover.style.visibility).toBe("visible");

    const head = popover.querySelector<HTMLElement>(".khasky-emojery-sticky-head")!;
    const firstItem = popover.querySelector<HTMLElement>(".khasky-emojery-grid-item")!;
    expect(head.classList.contains("khasky-emojery-sticky-head--bottom")).toBe(false);
    expect(head.compareDocumentPosition(firstItem) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(popover.getBoundingClientRect().top).toBeGreaterThanOrEqual(trigger.getBoundingClientRect().bottom - 1);
  });

  it("opens above when the trigger sits low: sticky head moves to the bottom, glued to the button", async () => {
    // Park the trigger hard against the bottom edge - no room below, plenty
    // above - so Picker flips to the mirrored layout.
    container.style.cssText = "position: fixed; left: 40px; bottom: 12px;";
    mountPicker();
    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;
    await userEvent.click(trigger);
    const popover = await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-popover"));
    await expect.poll(() => popover.style.visibility).toBe("visible");

    const head = popover.querySelector<HTMLElement>(".khasky-emojery-sticky-head")!;
    const firstItem = popover.querySelector<HTMLElement>(".khasky-emojery-grid-item")!;
    expect(head.classList.contains("khasky-emojery-sticky-head--bottom"), "expected the mirrored above-layout - is the test viewport tall enough?").toBe(true);
    expect(firstItem.compareDocumentPosition(head) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const gap = () => trigger.getBoundingClientRect().top - popover.getBoundingClientRect().bottom;
    expect(gap()).toBeGreaterThanOrEqual(0);
    expect(gap()).toBeLessThan(20);

    // The fix: searching shrinks the popover, but its bottom stays glued to the
    // trigger - the search box never jumps to the far top.
    const search = popover.querySelector<HTMLInputElement>(".khasky-emojery-search")!;
    await userEvent.fill(search, "fire");
    await expect.poll(() => Array.from(popover.querySelectorAll<HTMLElement>(".khasky-emojery-grid-item")).some((el) => (el.getAttribute("aria-label") ?? "").toLowerCase().includes("fire"))).toBe(true);
    await expect.poll(() => gap() >= 0 && gap() < 20).toBe(true);
  });
});

describe("Picker - keyboard a11y (real focus)", () => {
  it("Tab reaches the trigger, Enter opens, Escape closes and restores focus", async () => {
    mountPicker();
    const trigger = container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!;

    await userEvent.tab();
    expect(document.activeElement).toBe(trigger);

    await userEvent.keyboard("{Enter}");
    await pollForElement(() => portalRoot.querySelector('[role="dialog"]'));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    await userEvent.keyboard("{Escape}");
    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).toBeNull();
    // Esc returns focus to the trigger (picker-hooks.ts usePopoverDismiss onKey handler).
    expect(document.activeElement).toBe(trigger);
  });

  it("arrow keys move focus across the emoji grid", async () => {
    mountPicker();
    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
    const search = await pollForElement(() => portalRoot.querySelector<HTMLInputElement>(".khasky-emojery-search"));
    search.focus();
    await userEvent.keyboard("{ArrowDown}");

    const first = document.activeElement as HTMLElement;
    expect(first.classList.contains("khasky-emojery-grid-item")).toBe(true);
    expect(first.hasAttribute("aria-pressed")).toBe(true);

    await userEvent.keyboard("{ArrowRight}");
    const items = Array.from(portalRoot.querySelectorAll<HTMLButtonElement>(".khasky-emojery-grid-item"));
    const second = document.activeElement as HTMLElement;
    // The NEXT item, not merely a different one: "moved somewhere" passed even
    // with the step size wrong (see picker-hooks.test.ts gridTargetIndex).
    expect(second).toBe(items[items.indexOf(first as HTMLButtonElement) + 1]);
    // ...and the roving tabindex followed it, so Tab still has exactly one stop here.
    expect(first.tabIndex).toBe(-1);
    expect(second.tabIndex).toBe(0);
  });

  // WCAG 2.4.11 Focus Not Obscured. The sticky head (search + category bar) is opaque and
  // lives INSIDE the scroll container, so the browser's own "scroll the focused element to
  // the scrollport edge" puts a cell arrowed-to from below underneath it. picker.css's
  // scroll-padding, fed the head's measured height by picker.tsx, moves that edge down.
  it("arrowing back up never leaves the focused emoji under the sticky head", async () => {
    mountPicker();
    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
    const search = await pollForElement(() => portalRoot.querySelector<HTMLInputElement>(".khasky-emojery-search"));
    const head = await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-sticky-head"));
    search.focus();
    await userEvent.keyboard("{ArrowDown}");

    // Deep enough that the grid has really scrolled, then back up one row at a time:
    // each of those steps scrolls a row IN from above, which is the obscured case.
    await userEvent.keyboard("{ArrowDown>60/}");
    for (let step = 0; step < 6; step++) {
      await userEvent.keyboard("{ArrowUp>6/}");
      const focused = document.activeElement as HTMLElement;
      expect(focused.classList.contains("khasky-emojery-grid-item")).toBe(true);
      const cell = focused.getBoundingClientRect();
      const headBox = head.getBoundingClientRect();
      // 1px of slack for sub-pixel rounding; anything more is the cell tucked behind it.
      expect(cell.top, `focused emoji at ${cell.top} is above the sticky head's bottom edge ${headBox.bottom}`).toBeGreaterThanOrEqual(headBox.bottom - 1);
    }
  });
});

describe("Picker - breakdown pagination (top-3 -> Show more <=10)", () => {
  // Mount with 12 distinct reactions so there is more than the 3-row initial
  // view AND more than the 10-row expanded cap (proves the cap holds).
  function mountWithCounts(): void {
    const emojis = REACTIONS.slice(0, 12);
    const counts: Record<string, number> = {};
    emojis.forEach((e, i) => {
      counts[e] = 120 - i * 5; // strictly descending -> deterministic sort order
    });
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    render(
      h(Picker, {
        initial: {
          value: { counts, total, loaded: emojis.length, hasMore: false },
          myReaction: null,
          isAuthed: true,
        },
        onPick: () => true,
        onSignIn: () => {},
        portalRoot,
      }),
      container,
    );
  }

  it("the trigger shows exactly the top 3 emojis", () => {
    mountWithCounts();
    const counter = container.querySelector(".khasky-emojery-counter");
    expect(counter, "counter trigger renders when reactions exist").not.toBeNull();
    expect(counter!.querySelectorAll(".khasky-emojery-counter-emojis > span").length).toBe(3);
  });

  it("breakdown opens at 3 rows, expands to <=10, then collapses back to 3", async () => {
    mountWithCounts();
    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-counter")!);
    const popover = await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-popover"));
    const rowCount = () => popover.querySelectorAll(".khasky-emojery-breakdown-row").length;
    const moreBtn = () => popover.querySelector<HTMLButtonElement>(".khasky-emojery-breakdown-more");

    await expect.poll(rowCount).toBe(3);
    expect(moreBtn(), "Show more is offered when >3 reactions exist").not.toBeNull();

    await userEvent.click(moreBtn()!);
    await expect.poll(rowCount).toBe(10); // hard cap, even though 12 exist

    await userEvent.click(moreBtn()!);
    await expect.poll(rowCount).toBe(3);
  });
});

// The trigger color is driven by `--khasky-emojery-site-fg` (mount.ts copies the
// site's own text color onto the host), so a site's OWN dark theme - independent of the
// OS scheme - keeps the trigger readable instead of rendering a dark glyph on dark.
describe("Picker - site dark theme (trigger inherits the site fg)", () => {
  it("renders the trigger in the site's light-on-dark foreground", () => {
    // e.g. GitHub dark: near-white text (#f0f6fc) on #0d1117.
    container.style.background = "#0d1117";
    container.style.setProperty("--khasky-emojery-site-fg", "#f0f6fc");
    mountPicker();

    const trigger = container.querySelector<HTMLElement>(".khasky-emojery-trigger")!;
    const color = getComputedStyle(trigger).color;
    const [r, g, b] = parseRgb(color);
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    expect(luminance, `trigger color ${color} should be light on a dark site`).toBeGreaterThan(180);
  });
});

// One shortcut per category; clicking one smooth-scrolls the grid to that section.
// (The grayscale->colour scroll-spy is geometry-driven and verified live, not here.)
describe("Picker - category nav bar", () => {
  // WCAG 2.5.8 Target Size (Minimum). `flex: 1 1 0` divides the bar by the category count,
  // so every category added shrinks all of them; at the stylesheet's 14px font floor the
  // present set clears 24 CSS px by a fraction of a pixel. Asserted at that floor on
  // purpose: at the test page's own font size the buttons are comfortably wide and the
  // assert would pass while the shipped worst case failed.
  it("keeps every category target at 24 CSS px, even at the smallest page font", async () => {
    // The clamp's bounds are declared on `:host`, which matches nothing in this light-DOM
    // render - without them the popover's font-size is invalid at computed-value time and
    // falls back to the test page's 16px, i.e. NOT the floor this test is named for.
    const fontMin = /--khasky-emojery-font-min:\s*([\d.]+px)/.exec(PICKER_STYLESHEET)?.[1];
    const fontMax = /--khasky-emojery-font-max:\s*([\d.]+px)/.exec(PICKER_STYLESHEET)?.[1];
    expect(fontMin && fontMax, "picker.css must declare both font bounds").toBeTruthy();
    portalRoot.style.setProperty("--khasky-emojery-font-min", fontMin!);
    portalRoot.style.setProperty("--khasky-emojery-font-max", fontMax!);

    render(
      h(Picker, {
        initial: emptyInitial(),
        // Below the stylesheet's --khasky-emojery-font-min, so the clamp lands on it.
        typography: { fontSize: "8px" },
        onPick: () => true,
        onSignIn: () => {},
        portalRoot,
      }),
      container,
    );
    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
    await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-cat-bar"));

    const buttons = Array.from(portalRoot.querySelectorAll<HTMLElement>(".khasky-emojery-cat-btn"));
    expect(buttons).toHaveLength(CATEGORIES.length);

    // The bar keeps all its targets on one row only while the popover is wide enough for
    // them plus the chrome around them (see the width floor in picker.css for the terms).
    // Asserted on the popover's width, not on the rendered rows: the wrap reproduces only
    // where the scroll container's scrollbar takes layout width, which this browser's does not.
    const popover = portalRoot.querySelector<HTMLElement>(".khasky-emojery-popover")!;
    const base = Number.parseFloat(fontMin!);
    const needed = CATEGORIES.length * 24 + (CATEGORIES.length - 1) * 0.1 * base + 1.65 * base + 17;
    // Floored: the engine resolves the same calc to 1/64-px precision, so an exact
    // comparison fails on the rounding rather than on a bar that no longer fits.
    expect(popover.getBoundingClientRect().width, "popover too narrow for a single-row category bar").toBeGreaterThanOrEqual(Math.floor(needed));

    for (const button of buttons) {
      const rect = button.getBoundingClientRect();
      expect(rect.width, `category "${button.getAttribute("aria-label")}" is ${rect.width}px wide`).toBeGreaterThanOrEqual(24);
      expect(rect.height, `category "${button.getAttribute("aria-label")}" is ${rect.height}px tall`).toBeGreaterThanOrEqual(24);
    }
  });

  it("renders one shortcut per category and scrolls the grid on click", async () => {
    mountPicker();
    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
    const bar = await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-cat-bar"));
    const buttons = bar.querySelectorAll<HTMLButtonElement>(".khasky-emojery-cat-btn");
    expect(buttons.length).toBe(CATEGORIES.length);

    const scroll = portalRoot.querySelector<HTMLElement>(".khasky-emojery-popover-scroll")!;
    expect(scroll.scrollTop).toBe(0);

    // Jump to a category well down the list (Food & Drink, index 4) - the
    // grid must scroll down to bring its section under the sticky header.
    await userEvent.click(buttons[4]!);
    await expect.poll(() => scroll.scrollTop).toBeGreaterThan(0);
  });
});

// The Popular set is fetched from the backend; with no baked-in fallback the
// section is omitted entirely until a list has been cached. The dynamic
// "adopts the cached list" path is covered in shared/popular.test.ts.
describe("Picker - Popular section", () => {
  const headers = () => Array.from(portalRoot.querySelectorAll<HTMLElement>(".khasky-emojery-section-h"));

  it("is omitted when no Popular list has been cached", async () => {
    mountPicker();
    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);
    await pollForElement(() => portalRoot.querySelector(".khasky-emojery-grid-item"));
    expect(headers().some((h) => h.textContent?.trim() === "Popular")).toBe(false);
  });
});

// The Recently Used section carries a Clear action that empties the list
// (resetting the derived stats) without touching history.
describe("Picker - clear Recently Used", () => {
  it("removes the section and resets the user's recents stats on click", async () => {
    const userId = "user-clear";
    const now = Date.now();
    chromeShim.local.set("auth_v1", {
      userId,
      expiresAt: Math.floor(now / 1000) + 3600,
    });
    chromeShim.local.set("recents_v1", {
      [userId]: {
        "🔥": { count: 1, lastUsed: now - 1000 },
        "❤️": { count: 1, lastUsed: now - 2000 },
      },
    });
    mountPicker();
    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);

    const clearBtn = await pollForElement(() => portalRoot.querySelector<HTMLButtonElement>(".khasky-emojery-section-clear"));

    // Trusted-gesture gate, see picker.tsx handlePick: a script-dispatched click must not
    // wipe the account's stored stats. Waited out over two frames so an unguarded handler's
    // state flush and its storage write would both have landed by the assertions.
    clearBtn.click();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(portalRoot.querySelector(".khasky-emojery-section-clear"), "a synthetic click must not clear Recently Used").not.toBeNull();
    expect(chromeShim.local.get("recents_v1"), "a synthetic click must not touch the stored stats").toEqual({
      [userId]: {
        "🔥": { count: 1, lastUsed: now - 1000 },
        "❤️": { count: 1, lastUsed: now - 2000 },
      },
    });

    await userEvent.click(clearBtn);

    await expect.poll(() => portalRoot.querySelector(".khasky-emojery-section-clear")).toBeNull();
    // The account's whole entry goes, not just its emojis - the blob is keyed by
    // userId and an emptied record would be indistinguishable dead weight.
    await expect.poll(() => chromeShim.local.get("recents_v1")).toEqual({});
  });
});

describe("Picker - signed-out gate", () => {
  it("a trigger click opens the real picker, gate and auth tab both held back", async () => {
    let signIns = 0;
    mountSignedOutPicker(() => {
      signIns++;
    });

    await userEvent.click(container.querySelector<HTMLButtonElement>(".khasky-emojery-trigger")!);

    // Signed out gets the whole path - search and palette - not a wall in front of it.
    await expect.poll(() => portalRoot.querySelector(".khasky-emojery-search")).not.toBeNull();
    expect(portalRoot.querySelectorAll(".khasky-emojery-grid-item").length).toBeGreaterThan(0);
    expect(portalRoot.querySelector(".khasky-emojery-gate")).toBeNull();
    expect(signIns, "the auth tab must wait for the gate's own button").toBe(0);
  });

  it("picking a reaction raises the gate on that emoji, casting nothing yet", async () => {
    let signIns = 0;
    const picked: (string | null)[] = [];
    mountSignedOutPicker(
      () => {
        signIns++;
      },
      {
        onPick: (reaction) => {
          picked.push(reaction);
          return true;
        },
      },
    );

    const emoji = await pickWhileSignedOut();

    const gate = await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-gate"));
    expect(gate.querySelector(".khasky-emojery-gate-emoji")?.textContent?.trim(), "the gate carries the emoji the user chose").toBe(emoji);
    expect(picked, "an unauthed pick must not reach the host").toEqual([]);
    expect(signIns, "the auth tab must wait for the gate's own button").toBe(0);
    expect(portalRoot.querySelector(".khasky-emojery-grid-item"), "the gate replaces the palette").toBeNull();
  });

  it("gives both gate buttons the full popover width", async () => {
    mountSignedOutPicker(() => {});
    await pickWhileSignedOut();

    const signInBtn = await pollForElement(() => portalRoot.querySelector<HTMLButtonElement>(".khasky-emojery-gate-signin"));
    const cancel = portalRoot.querySelector<HTMLButtonElement>(".khasky-emojery-gate-cancel")!;
    // The title is a padding-free block, so its box IS the gate's content width.
    const contentWidth = portalRoot.querySelector<HTMLElement>(".khasky-emojery-gate-title")!.getBoundingClientRect().width;

    expect(signInBtn.getBoundingClientRect().width).toBeCloseTo(contentWidth, 0);
    expect(cancel.getBoundingClientRect().width).toBeCloseTo(contentWidth, 0);
  });

  it("only the gate's sign-in button opens the auth tab, and the popover survives it", async () => {
    let signIns = 0;
    mountSignedOutPicker(() => {
      signIns++;
    });
    await pickWhileSignedOut();

    const signInBtn = await pollForElement(() => portalRoot.querySelector<HTMLButtonElement>(".khasky-emojery-gate-signin"));
    await userEvent.click(signInBtn);

    expect(signIns).toBe(1);
    // Open while the auth tab is used, so the pick is still held when sign-in lands.
    expect(portalRoot.querySelector(".khasky-emojery-gate")).not.toBeNull();
  });

  it("the cancel button closes the gate", async () => {
    mountSignedOutPicker(() => {});
    await pickWhileSignedOut();

    const cancel = await pollForElement(() => portalRoot.querySelector<HTMLButtonElement>(".khasky-emojery-gate-cancel"));
    await userEvent.click(cancel);

    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).toBeNull();
  });

  it("signing in casts the reaction the gate was holding", async () => {
    let pushRefresh: RefreshPush | null = null;
    const picked: (string | null)[] = [];
    mountSignedOutPicker(() => {}, {
      captureRefresh: (cb) => {
        pushRefresh = cb;
      },
      onPick: (reaction) => {
        picked.push(reaction);
        return true;
      },
    });

    const emoji = await pickWhileSignedOut();
    await pollForElement(() => portalRoot.querySelector<HTMLElement>(".khasky-emojery-gate"));

    pushRefresh!({ myReaction: null, authed: true });

    // The pick survives the trip through the auth tab and is cast on return.
    await expect.poll(() => picked).toEqual([emoji]);
    await expect.poll(() => portalRoot.querySelector('[role="dialog"]')).toBeNull();
  });

  it("a cancelled gate forgets the pick, so a later sign-in casts nothing", async () => {
    let pushRefresh: RefreshPush | null = null;
    const picked: (string | null)[] = [];
    mountSignedOutPicker(() => {}, {
      captureRefresh: (cb) => {
        pushRefresh = cb;
      },
      onPick: (reaction) => {
        picked.push(reaction);
        return true;
      },
    });

    await pickWhileSignedOut();
    const cancel = await pollForElement(() => portalRoot.querySelector<HTMLButtonElement>(".khasky-emojery-gate-cancel"));
    await userEvent.click(cancel);

    pushRefresh!({ myReaction: null, authed: true });

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    expect(picked).toEqual([]);
  });

  it("a signed-out deep-link auto-open lands on the palette", async () => {
    let signIns = 0;
    mountSignedOutPicker(
      () => {
        signIns++;
      },
      { autoOpen: true },
    );

    await expect.poll(() => portalRoot.querySelector(".khasky-emojery-search")).not.toBeNull();
    expect(portalRoot.querySelector(".khasky-emojery-gate")).toBeNull();
    expect(signIns, "auto-open must not open the auth tab uninvited").toBe(0);
  });
});

// Deliberately NOT mount-color.ts's parseRgb: that one answers `null` for an unpaintable
// colour, which is the right production behaviour and the wrong test behaviour - a computed
// style this cannot read means the assertion below never ran, and it has to say so.
function parseRgb(value: string): [number, number, number] {
  const m = value.match(/rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
  if (!m) throw new Error(`unexpected color string: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// Small poll helper so the search box (rendered a tick after the popover opens)
// is awaited without a brittle fixed timeout.
async function pollForElement<T>(get: () => T | null, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = get();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("pollForElement: element never appeared");
    await new Promise((r) => setTimeout(r, 25));
  }
}
