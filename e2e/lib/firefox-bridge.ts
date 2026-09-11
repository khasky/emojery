// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Firefox run's way into the extension's OWN contexts. Playwright's juggler
// neither navigates to nor tracks `moz-extension://` pages, but the Remote
// Debugging Protocol socket the launcher already opens to install the temporary
// add-on (firefox-addon.ts) also reaches the add-on's background page and any
// tab it opens - the same actors about:debugging drives. This module wraps that:
//
//   - evalInBackground: run a function in the real background page (`browser.*`
//     is live there), the Firefox twin of `firstServiceWorker().evaluate`;
//   - openExtensionTab: open popup.html / auth.html / onboarding.html in a tab
//     (or a sized popup window) and evaluate functions against its document;
//   - tabsMatching: see which extension tabs exist, for "did the click open
//     auth.html" checks Playwright's page events cannot answer here.
//
// What it does NOT give: Playwright locators, screenshots, trusted input events
// or `expect` matchers against those pages. Specs that need those stay on the
// Chromium run; everything that can be expressed as "run this function in the
// page and judge its return value" ports through here.
//
// Every evaluate serializes the function with `Function.prototype.toString`, so
// the function must be self-contained: no closures over spec variables, and the
// WebExtension API reached as `browser` (Firefox's `chrome.*` is callback-style
// and returns no promise, verified - a body written for the Chromium service
// worker must read `(globalThis.browser ?? chrome)`).

import { connect, type Socket } from "node:net";
import type { BrowserContext } from "@playwright/test";
import { RdpConnection, type RdpPacket } from "./firefox-addon";

// The debugger port each Firefox context was launched with, recorded by the
// launcher so a helper can find its way back from the context it was handed.
const debuggerPorts = new WeakMap<BrowserContext, number>();
const bridges = new WeakMap<BrowserContext, Promise<FirefoxBridge>>();

export function registerFirefoxDebuggerPort(context: BrowserContext, port: number, addonId: string): void {
  debuggerPorts.set(context, port);
  addonIds.set(context, addonId);
}
const addonIds = new WeakMap<BrowserContext, string>();

// One bridge per context, connected on first use and dropped with the context
// (the socket dies with the browser; nothing to tear down by hand).
export function firefoxBridge(context: BrowserContext): Promise<FirefoxBridge> {
  let bridge = bridges.get(context);
  if (!bridge) {
    const port = debuggerPorts.get(context);
    const addonId = addonIds.get(context);
    if (port === undefined || addonId === undefined) throw new Error("This context was not launched through launchRealisticContext on the firefox run - no debugger port to bridge over");
    bridge = FirefoxBridge.connect(port, addonId);
    bridges.set(context, bridge);
  }
  return bridge;
}

interface EvalOutcome {
  ok: boolean;
  value?: unknown;
  error?: string;
}

type TabForm = { actor: string; url: string };

// Everything the bridge knows about one extension page it opened: how to
// evaluate in it and how to close it (through the background, since the tab
// belongs to a window Playwright never sees).
export class FirefoxExtensionTab {
  constructor(
    private readonly bridge: FirefoxBridge,
    private readonly consoleActor: string,
    readonly url: string,
    private readonly tabId: number,
    private readonly windowId: number | null,
    // The tab that was selected before this one opened. Firefox does not return
    // to it by itself when the tab closes, and a site tab left unselected is a
    // hidden document - where the content script pauses its scans.
    private readonly returnToTabId: number | null = null,
  ) {}

  evaluate<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A, timeoutMs?: number): Promise<T> {
    return this.bridge.evaluateIn(this.consoleActor, fn, arg, timeoutMs);
  }

  /** Run a script SOURCE in the page (a library such as axe-core): the console
   *  evaluates it outside the page's CSP, the way Playwright's addInitScript does. */
  async injectScript(source: string): Promise<void> {
    await this.bridge.evaluateRaw(this.consoleActor, source, 60_000);
  }

  /** Resize the page's content area (the window was opened as its own popup
   *  window for this). Needs a context launched with `viewport: null`: under
   *  Playwright's viewport emulation every window paints at the emulated size. */
  async setContentSize(size: { width: number; height: number }): Promise<void> {
    if (this.windowId === null) throw new Error("setContentSize needs a tab opened with openExtensionWindow");
    const windowId = this.windowId;
    const read = () => this.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    // windows.update resolves before the content reflows to the new size: read
    // until two consecutive reads agree (or the wait runs out) before trusting one.
    const resizeTo = async (outer: { width: number; height: number }) => {
      await this.bridge.evalInBackground(({ windowId, outer }) => browser.windows.update(windowId, { width: outer.width, height: outer.height }).then(() => undefined), { windowId, outer });
      let last = await read();
      for (let i = 0; i < 30; i += 1) {
        await new Promise((settle) => setTimeout(settle, 100));
        const next = await read();
        if (next.width === last.width && next.height === last.height) return next;
        last = next;
      }
      return last;
    };
    // The chrome around the content (title bar, borders) is a fixed delta per
    // platform: measure it from one resize, then ask for the compensated size.
    const first = await resizeTo(size);
    const delta = { width: size.width - first.width, height: size.height - first.height };
    const settled = delta.width !== 0 || delta.height !== 0 ? await resizeTo({ width: size.width + delta.width, height: size.height + delta.height }) : first;
    if (Math.abs(settled.width - size.width) > 1 || Math.abs(settled.height - size.height) > 1) {
      throw new Error(`Could not size the extension window to ${size.width}x${size.height} (got ${settled.width}x${settled.height}) - was the context launched with viewport: null?`);
    }
  }

  async close(): Promise<void> {
    // A tab the extension opened itself (attach), not the bridge: no tab id to
    // remove it by, so the page closes itself - dom.allow_scripts_to_close_windows
    // is set for exactly this (firefox-addon.ts).
    if (this.tabId < 0 && this.windowId === null) {
      await this.evaluate(() => window.close()).catch(() => {});
      return;
    }
    if (this.windowId !== null) {
      const windowId = this.windowId;
      await this.bridge.evalInBackground((id) => browser.windows.remove(id), windowId).catch(() => {});
      return;
    }
    const ids = { tabId: this.tabId, returnTo: this.returnToTabId };
    await this.bridge
      .evalInBackground(async ({ tabId, returnTo }) => {
        await browser.tabs.remove(tabId);
        if (returnTo !== null) await browser.tabs.update(returnTo, { active: true }).catch(() => undefined);
      }, ids)
      .catch(() => {});
  }
}

export class FirefoxBridge {
  private queue: Promise<unknown> = Promise.resolve();
  private slotCounter = 0;

  private constructor(
    private readonly rdp: RdpConnection,
    private readonly backgroundConsole: string,
  ) {}

  static async connect(port: number, addonId: string): Promise<FirefoxBridge> {
    const socket = await new Promise<Socket>((resolveSocket, reject) => {
      const s = connect({ host: "127.0.0.1", port }, () => resolveSocket(s));
      s.once("error", reject);
    });
    const rdp = new RdpConnection(socket);
    await rdp.waitFor((p) => p.from === "root", "the root hello");
    rdp.send({ to: "root", type: "listAddons" });
    const listed = await rdp.waitFor((p) => p.from === "root" && Array.isArray(p.addons), "the add-on list");
    const addon = (listed.addons as Array<{ id?: string; actor?: string }>).find((entry) => entry.id === addonId);
    if (!addon?.actor) throw new Error(`The add-on ${addonId} is not installed in this Firefox - was installTemporaryAddon run?`);
    rdp.send({ to: addon.actor, type: "getWatcher", isServerTargetSwitchingEnabled: true });
    const watcher = await rdp.waitFor((p) => p.from === addon.actor && typeof p.actor === "string", "the add-on's watcher");
    rdp.send({ to: watcher.actor as string, type: "watchTargets", targetType: "frame" });
    // The watcher first reports a devtools fallback document (no `browser` global
    // in it), then the real background page - wait for the moz-extension one.
    const target = await rdp.waitFor((p) => p.from === watcher.actor && p.type === "target-available-form" && typeof (p.target as { url?: string } | undefined)?.url === "string" && (p.target as { url: string }).url.startsWith("moz-extension://"), "the background page target", 20_000);
    const consoleActor = (target.target as { consoleActor?: string }).consoleActor;
    if (!consoleActor) throw new Error("The background page target carries no console actor");
    return new FirefoxBridge(rdp, consoleActor);
  }

  /** Run `fn(arg)` inside the add-on's background page and return its (JSON-round-tripped) result. */
  evalInBackground<T, A = undefined>(fn: (arg: A) => T | Promise<T>, arg?: A, timeoutMs?: number): Promise<T> {
    return this.evaluateIn(this.backgroundConsole, fn, arg, timeoutMs);
  }

  /** The tabs Firefox reports, by url - `moz-extension://` ones included. */
  async tabsMatching(url: RegExp): Promise<TabForm[]> {
    return (await this.listTabs()).filter((tab) => url.test(tab.url));
  }

  /** The first open extension tab whose url matches - one the EXTENSION opened
   *  (a sign-in gate's auth.html), which Playwright's page events never report here. */
  async attach(url: RegExp): Promise<FirefoxExtensionTab | null> {
    const tab = (await this.listTabs()).find((form) => url.test(form.url));
    if (!tab) return null;
    return new FirefoxExtensionTab(this, await this.consoleActorOf(tab.actor), tab.url, -1, null);
  }

  /** Open an extension page in a tab of the current window. */
  openExtensionTab(path: string): Promise<FirefoxExtensionTab> {
    return this.openExtensionPage(path, null);
  }

  /** Open an extension page in its own popup-type window, so its content area can
   *  be sized (setContentSize) the way a spec sizes a Playwright page's viewport. */
  openExtensionWindow(path: string, size: { width: number; height: number }): Promise<FirefoxExtensionTab> {
    return this.openExtensionPage(path, size);
  }

  private async openExtensionPage(path: string, windowSize: { width: number; height: number } | null): Promise<FirefoxExtensionTab> {
    const before = new Set((await this.listTabs()).map((tab) => tab.actor));
    const opened = await this.evalInBackground(
      async ({ path, windowSize }) => {
        const url = browser.runtime.getURL(path);
        if (windowSize) {
          const win = await browser.windows.create({ url, type: "popup", width: windowSize.width, height: windowSize.height });
          return { url, tabId: win.tabs?.[0]?.id ?? -1, windowId: win.id ?? -1, returnTo: null };
        }
        const [selected] = await browser.tabs.query({ active: true, currentWindow: true });
        const tab = await browser.tabs.create({ url });
        return { url, tabId: tab.id ?? -1, windowId: null, returnTo: selected?.id ?? null };
      },
      { path, windowSize },
    );
    // The tab shows up in listTabs once its document exists; a fresh one is the
    // matching url that was not there before.
    const deadline = Date.now() + 15_000;
    for (;;) {
      const fresh = (await this.listTabs()).find((tab) => !before.has(tab.actor) && tab.url.startsWith(opened.url));
      if (fresh) {
        const consoleActor = await this.consoleActorOf(fresh.actor);
        const page = new FirefoxExtensionTab(this, consoleActor, fresh.url, opened.tabId, opened.windowId, opened.returnTo);
        // Parity with Playwright's goto: the document is parsed before the caller reads it.
        await page.evaluate(() => (document.readyState === "loading" ? new Promise<void>((done) => document.addEventListener("DOMContentLoaded", () => done(), { once: true })) : undefined));
        return page;
      }
      if (Date.now() > deadline) throw new Error(`The extension page ${path} never appeared in Firefox's tab list`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private async listTabs(): Promise<TabForm[]> {
    const listed = await this.request({ to: "root", type: "listTabs" }, (p) => p.from === "root" && Array.isArray(p.tabs), "the tab list");
    return (listed.tabs as Array<{ actor: string; url: string }>).map((tab) => ({ actor: tab.actor, url: tab.url }));
  }

  private async consoleActorOf(tabActor: string): Promise<string> {
    const target = await this.request({ to: tabActor, type: "getTarget" }, (p) => p.from === tabActor && typeof p.frame === "object", "the tab target");
    const consoleActor = (target.frame as { consoleActor?: string }).consoleActor;
    if (!consoleActor) throw new Error("The tab target carries no console actor");
    return consoleActor;
  }

  // One RDP request at a time: the connection matches replies by actor only, so
  // two in-flight requests to the same actor could swap answers.
  private request(packet: Record<string, unknown>, match: (p: RdpPacket) => boolean, what: string, timeoutMs = 15_000): Promise<RdpPacket> {
    const run = this.queue.then(() => {
      this.rdp.send(packet);
      return this.rdp.waitFor(match, what, timeoutMs);
    });
    this.queue = run.catch(() => {});
    return run;
  }

  async evaluateRaw(consoleActor: string, text: string, timeoutMs = 30_000): Promise<unknown> {
    const reply = await this.request({ to: consoleActor, type: "evaluateJSAsync", text }, (p) => p.from === consoleActor && p.type === "evaluationResult", "an evaluation result", timeoutMs);
    if (reply.exception !== undefined && reply.exception !== null) throw new Error(`Evaluation threw in the extension page: ${String(reply.exceptionMessage ?? reply.exception)}`);
    return reply.result;
  }

  // The console cannot await: the call is started, its settled outcome parked on a
  // global slot as JSON, and the slot polled - primitives and strings come back as
  // themselves, everything else would be an object grip.
  async evaluateIn<T, A>(consoleActor: string, fn: (arg: A) => T | Promise<T>, arg: A | undefined, timeoutMs = 30_000): Promise<T> {
    const slot = `__emojeryE2e${++this.slotCounter}`;
    const script = `(() => {
      const run = (${fn.toString()});
      const arg = ${JSON.stringify(arg ?? null)};
      globalThis[${JSON.stringify(slot)}] = null;
      Promise.resolve().then(() => run(arg)).then(
        (value) => { globalThis[${JSON.stringify(slot)}] = JSON.stringify({ ok: true, value: value === undefined ? null : value }); },
        (error) => { globalThis[${JSON.stringify(slot)}] = JSON.stringify({ ok: false, error: String((error && error.stack) || error) }); },
      );
    })()`;
    await this.evaluateRaw(consoleActor, script);
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const parked = await this.evaluateRaw(consoleActor, `globalThis[${JSON.stringify(slot)}]`);
      if (typeof parked === "string") {
        await this.evaluateRaw(consoleActor, `delete globalThis[${JSON.stringify(slot)}]`).catch(() => {});
        const outcome = JSON.parse(parked) as EvalOutcome;
        if (!outcome.ok) throw new Error(`Function threw in the extension context: ${outcome.error}`);
        return outcome.value as T;
      }
      if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for a function to settle in the extension context`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}
