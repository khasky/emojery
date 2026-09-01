// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bridge to a REAL, human-launched Chrome via the Playwright Extension. We act
// as an MCP client to `@playwright/mcp` running in `--extension` mode - the
// browser is started normally by the user (no automation launch fingerprint, no
// `navigator.webdriver`; only `chrome.debugger` attaches, like DevTools), which
// is why bot-sensitive platforms don't flag it. See the site-auth README.
//
// Two connection modes:
//   - default: in-process `createConnection({ extension: true })` linked to our
//     client over an in-memory transport (single command, no port);
//   - `E2E_MCP_URL`: connect to an already-running `@playwright/mcp
//     --extension --port <p>` over streamable HTTP (`http://host:p/mcp`).
//
// All page interaction goes through `browser_run_code_unsafe`, which hands a
// full Playwright `page`. Playwright's CSS engine pierces the open shadow roots
// the trigger/picker live in, so selector clicks/reads are reliable (the
// snapshot-ref tools can't address shadow content as robustly). Returned values
// are sentinel-wrapped JSON so we can parse them out of the MCP text envelope.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const SENTINEL = "<<SE>>";
const ERR_SENTINEL = "<<SE_ERR>>";

// Per-call ceiling for one `browser_run_code_unsafe`. No body here legitimately
// runs this long (the longest are a bounded goto and a few 8s Playwright
// clicks), while the MCP SDK's own default is 60s - and since a stalled call is
// retried once, a single stall cost 121s and blew straight past vitest's 120s
// hook budget instead of self-healing. Kept well under that budget.
const CALL_TIMEOUT_MS = 30_000;
// Navigation gets its own, lower ceiling (Playwright's default is 30s, i.e. the
// whole call budget) - callers already treat a failed goto as non-fatal and poll
// for the host afterwards.
const NAV_TIMEOUT_MS = 20_000;
// Navigation waits for `commit` (the response landed), never for a load event: a
// heavy logged-in permalink can stay `readyState === "loading"` for a minute
// (measured on a Facebook /posts/ permalink: DOM complete only ~66s in), and
// while it streams, EVERY bridge call inflates - so a `domcontentloaded` goto
// blew the whole per-call budget and its -32001 retry doubled the loss. The
// hydrate wait below is a SEPARATE call, so a page that never settles costs one
// bounded call instead of the navigation one; readiness is then established the
// way callers already do it, by polling for a mounted host.
const HYDRATE_WAIT_MS = 10_000;
const HYDRATE_WAIT = `await page.waitForLoadState('domcontentloaded', { timeout: ${HYDRATE_WAIT_MS} }).catch(() => {});`;

/**
 * Every failure this bridge produces, and nothing else. A test asserts about the
 * PAGE; a bridge that stalled, lost its relay or lost its tab has said nothing
 * about the page, and a helper that turns one into a zero hands the reader
 * "log into <site>" for an account that was signed in - the single most expensive
 * wrong message this suite can print. Helpers that observe rethrow these; only
 * best-effort side effects (dismiss a modal, mute a video) may swallow one.
 */
export class BridgeError extends Error {
  readonly bridge = true;
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BridgeError";
  }
}

export function isBridgeError(error: unknown): error is BridgeError {
  return error instanceof BridgeError || (typeof error === "object" && error !== null && (error as { bridge?: unknown }).bridge === true);
}

// No generic body ceiling on purpose: the only long-runner, page.mouse.wheel, is
// bounded at its call site (wheelBySrc in harness.ts), and a global one would risk
// a body that legitimately runs long.

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// Pull the sentinel-wrapped JSON payload back out of the MCP text envelope.
// The page returns `"<<SE>>" + json + "<<SE>>"`; the envelope may print that
// string raw or escaped, so we try a direct parse then an unescape-once parse.
function parseSentinel<T>(text: string): T {
  const errAt = text.indexOf(ERR_SENTINEL);
  if (errAt >= 0) {
    throw new Error(`probe threw in page: ${text.slice(errAt + ERR_SENTINEL.length).slice(0, 300)}`);
  }
  // Newer @playwright/mcp renders the return value inside a "### Result\n<json>\n###"
  // block where the value is JSON-stringified - so a returned string arrives with
  // its quotes escaped, which the raw sentinel scan below can't parse. Recover the
  // original returned string first. Older builds inlined the value, so fall back to
  // the full text when there is no Result block.
  let payload = text;
  const result = text.match(/###\s*Result\s*\n([\s\S]*?)\n###\s/);
  if (result?.[1]) {
    try {
      payload = JSON.parse(result[1].trim()) as string;
    } catch {
      payload = result[1];
    }
  }
  const a = payload.indexOf(SENTINEL);
  const b = payload.lastIndexOf(SENTINEL);
  if (a < 0 || b <= a) {
    throw new Error(`no probe payload in tool result: ${text.slice(0, 300)}`);
  }
  const raw = payload.slice(a + SENTINEL.length, b);
  try {
    return JSON.parse(raw) as T;
  } catch {
    // Envelope escaped the string one level (\" etc.) - unescape then parse.
    // `raw` already carries those escapes, so it goes between the quotes as-is:
    // re-escaping its own quotes turned every \" into \\" and made this branch
    // throw on the exact shape it exists for.
    return JSON.parse(JSON.parse(`"${raw}"`)) as T;
  }
}

export interface Bridge {
  /** Navigate the active tab; commits, then makes ONE bounded best-effort
   *  domcontentloaded attempt. Readiness comes from polling for a host, not from
   *  this (see the header). */
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  waitMs(ms: number): Promise<void>;
  /**
   * Poll `predicateSource` (a function body returning truthy when satisfied)
   * in-page until it holds or `timeoutMs` lapses; resolves with whether it
   * held. Prefer this over `waitMs`: the wait ends the moment the condition is
   * met instead of always paying the full budget.
   */
  waitFor(predicateSource: string, timeoutMs: number): Promise<boolean>;
  /** `page.evaluate` of a probe source string (a `function` body with `return`). */
  evaluate<T>(probeSource: string): Promise<T>;
  press(key: string): Promise<void>;
  /** URLs of all open tabs - used to confirm we attached to the real browser. */
  tabUrls(): Promise<string[]>;
  /** Open a second tab on `url`. Callers address it as the LAST page (see close()). */
  openTab(url: string): Promise<void>;
  /** Escape hatch: run a custom `async (page) => {...}` body that returns a value. */
  run<T>(returnExpr: string): Promise<T>;
  /** Escape hatch: run a custom `async (page) => {...}` action body (no return). */
  act(body: string): Promise<void>;
  close(): Promise<void>;
}

// Our MCP client name, and the ONLY thing that identifies the browser tab a
// connection leaves behind. Establishing an extension bridge spawns Chrome on
// `chrome-extension://<playwright-extension>/connect.html?...&client={"name":<this>}`
// - a NEW tab per connection, i.e. one per test file - and nothing on the
// Playwright side ever closes it. close() closes it, matching on this name so a
// connect page belonging to another Playwright client in the same browser (an
// agent's live bridge) is never touched.
const CLIENT_NAME = "emojery-siteauth";

// Closing our OWN connect page drops the relay mid-command, so that reply may
// never arrive. Cap the wait instead of paying the 30s call timeout (twice, with
// the retry) on every file's teardown.
const CONNECT_TAB_CLOSE_MS = 4_000;

// Bridge-side source that closes the connect.html tabs THIS client's relays left
// in the browser. `keepNewest` spares the last one - ours - so a fresh connection
// can clear what a killed run or a died teardown left behind without cutting its
// own relay; teardown passes false and closes ours too, last.
// THE invariant every close in this file obeys: Chrome closes its window with the
// last tab, and the window taking the browser with it is how a run ended up telling
// the next test file "saw only about:blank" and then "Target page, context or
// browser has been closed" for everything after. A tab is worth closing; the
// browser the whole suite is driving is not. Defined once, used by every sweep.
const CLOSE_SAFE_SRC = `const closeSafe = async (p) => { if (page.context().pages().length <= 1) return; try { await p.close(); } catch {} };`;

const RELAY_TAB_SWEEP_SRC = (keepNewest: boolean): string =>
  `const relays = page.context().pages().filter((p) => { const u = p.url(); return u.startsWith('chrome-extension://') && u.includes('/connect.html?') && u.includes(${JSON.stringify(CLIENT_NAME)}); });
   for (const p of ${keepNewest ? "relays.slice(0, -1)" : "relays"}) { await closeSafe(p); }`;

// What @playwright/mcp does around EVERY tool call by default, and what neither
// half is worth to this bridge:
//  - `timeouts.settle` (500ms) holds each reply until the page's triggered work
//    quiets down. This bridge times its own waits (waitFor / waitMs / the explicit
//    page.waitForTimeout inside its bodies), so that hold is pure latency - and on
//    a feed that never stops fetching it is not a floor but an open ceiling.
//  - `snapshot.mode` builds an accessibility snapshot of the page for the reply.
//    parseSentinel reads the sentinel payload and nothing else, so every snapshot
//    is thrown away, and its cost grows with the DOM it walks.
// Measured over 12 sequential no-op evaluates per site, median round-trip:
// defaults 545ms (github) / 523ms (x) / 1003ms (facebook); with both off, 8 / 8 /
// 7ms. The suite makes thousands of calls, which is the difference between a run
// that finishes and one that does not. Settle is tunable per run for a page that
// turns out to need the quiet.
const MCP_SPEED = {
  snapshot: { mode: "none" },
  timeouts: { settle: Number(process.env.E2E_MCP_SETTLE_MS ?? 0) },
} as const;

export async function connectBridge(): Promise<Bridge> {
  // URLs of the tabs THIS bridge opened via openTab() in the user's real Chrome,
  // closed on teardown so a run never leaves stray tabs behind. Recorded by URL
  // and matched by URL, never by position: this drives the USER's browser, and a
  // tab they open mid-run would otherwise be the one teardown closes.
  let openedTabUrls: string[] = [];
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });

  // Set: connect to an already-running server instead of spawning in-process.
  const url = process.env.E2E_MCP_URL;
  let dispose: () => Promise<void>;

  if (url) {
    const transport = new StreamableHTTPClientTransport(new URL(url));
    await client.connect(transport);
    dispose = async () => {
      await client.close().catch(() => {});
    };
  } else {
    // In-process server attached to the running Chrome via the extension.
    // The extension token is read from PLAYWRIGHT_MCP_EXTENSION_TOKEN by
    // @playwright/mcp itself.
    const { createConnection } = (await import("@playwright/mcp")) as {
      createConnection: (config: unknown) => Promise<{
        connect(transport: unknown): Promise<void>;
        close?(): Promise<void>;
      }>;
    };
    const connection = await createConnection({ extension: true, ...MCP_SPEED });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await connection.connect(serverTransport);
    await client.connect(clientTransport);
    dispose = async () => {
      await client.close().catch(() => {});
      await connection.close?.().catch(() => {});
    };
  }

  const callTool = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const res = (await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as ToolResult;
    const text = (res.content ?? []).map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
    if (res.isError) throw new Error(`tool error: ${text.slice(0, 300)}`);
    return text;
  };

  const callRaw = (code: string): Promise<string> => callTool("browser_run_code_unsafe", { code });

  // Transient by nature, and the reason a call gets a second attempt:
  //  - an SPA route change destroys the JS execution context mid-call;
  //  - the relay answers past the MCP client's request timeout (-32001), which a
  //    renderer busy with its own work causes routinely on a live feed.
  const isTransient = (e: unknown): boolean => /context was destroyed|Execution context|-32001|Request timed out/i.test(String(e));
  const ATTEMPTS = 2;
  const RETRY_PAUSE_MS = 1_500;

  // The ONE place a bridge failure is minted, so no caller anywhere - today's or a
  // test written next year - can receive a raw McpError and mistake it for
  // something the page said. Everything that leaves here is a BridgeError.
  const call = async (code: string): Promise<string> => {
    let last: unknown;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        return await callRaw(code);
      } catch (e) {
        last = e;
        if (!isTransient(e)) break;
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, RETRY_PAUSE_MS));
      }
    }
    throw new BridgeError(`Site-auth bridge call failed after ${ATTEMPTS} attempts - this is the BRIDGE, not the page: ${String(last).slice(0, 200)}`, { cause: last });
  };

  const runAction = async (body: string): Promise<void> => {
    await call(`async (page) => { ${body} }`);
  };

  const runData = async <T>(returnExpr: string): Promise<T> => {
    const text = await call(`async (page) => {
      const __v = await (async () => { ${returnExpr} })();
      return ${JSON.stringify(SENTINEL)} + JSON.stringify(__v) + ${JSON.stringify(SENTINEL)};
    }`);
    try {
      return parseSentinel<T>(text);
    } catch (e) {
      // A probe that threw is the PAGE talking, and stays a plain error; an
      // envelope with no payload in it is the bridge failing to answer.
      if (String(e).includes("probe threw in page")) throw e;
      throw new BridgeError(`Site-auth bridge returned no readable payload: ${String(e).slice(0, 200)}`, { cause: e });
    }
  };

  // The extension opens a connect.html tab per connection and closes none of them,
  // so a killed run (or a file whose teardown died) leaves its relay tab standing
  // and the next run stacks another on top. Clear the leftovers, keeping the newest
  // - ours. Best-effort: a browser we cannot sweep is not a reason to fail.
  await runAction(`${CLOSE_SAFE_SRC} ${RELAY_TAB_SWEEP_SRC(true)}`).catch(() => {});

  // THE relay tab must never be the tab under test. With nothing selected in the
  // Playwright Extension the relay hands us its own connect.html page as `page`,
  // and navigating that page tears the relay down with it: every later call then
  // stalls into the 30s ceiling, for the whole run, on every site (measured: a run
  // where even github and amazon stalled). It hid during development because a
  // second Playwright client's connect tab was present and got driven instead.
  //
  // So: open a tab of our own and work there. `browser_tabs` makes the new tab the
  // current one, which is what moves `page` off the relay page. Recorded, because
  // teardown closes it - a tab we opened is the only tab we may close blind, and
  // closing it is what keeps a run tab-neutral. A relay bound to a tab the USER
  // picked reads as a site URL: left alone, worked in, never closed.
  const ownWorkingTab = await runData<string>(`return page.url();`)
    .then(async (current) => {
      if (!/^chrome-extension:\/\/.*\/connect\.html\?/.test(current)) return false;
      await callTool("browser_tabs", { action: "new", url: "about:blank" });
      return true;
    })
    .catch(() => false);

  return {
    async goto(u) {
      await runAction(`await page.goto(${JSON.stringify(u)}, { waitUntil: 'commit', timeout: ${NAV_TIMEOUT_MS} }).catch(() => {});`);
      await runAction(HYDRATE_WAIT);
    },
    async reload() {
      await runAction(`await page.reload({ waitUntil: 'commit', timeout: ${NAV_TIMEOUT_MS} }).catch(() => {});`);
      await runAction(HYDRATE_WAIT);
    },
    async waitMs(ms) {
      await runAction(`await page.waitForTimeout(${Math.max(0, Math.floor(ms))});`);
    },
    async waitFor(predicateSource, timeoutMs) {
      return runData<boolean>(`return await page.waitForFunction(() => { ${predicateSource} }, undefined, { timeout: ${Math.max(0, Math.floor(timeoutMs))} }).then(() => true, () => false);`);
    },
    async evaluate<T>(probeSource: string): Promise<T> {
      return runData<T>(`return await page.evaluate(() => { ${probeSource} });`);
    },
    async press(key) {
      await runAction(`await page.keyboard.press(${JSON.stringify(key)});`);
    },
    async tabUrls() {
      return runData<string[]>(`return page.context().pages().map((p) => p.url());`);
    },
    async openTab(u) {
      await runAction(`const np = await page.context().newPage(); await np.goto(${JSON.stringify(u)}, { waitUntil: 'commit', timeout: ${NAV_TIMEOUT_MS} }).catch(() => {}); await np.waitForLoadState('domcontentloaded', { timeout: ${HYDRATE_WAIT_MS} }).catch(() => {});`);
      openedTabUrls.push(u);
    },
    async run<T>(returnExpr: string): Promise<T> {
      return runData<T>(returnExpr);
    },
    async act(body: string): Promise<void> {
      await runAction(body);
    },
    async close() {
      // ONE call for every sweep, straight through callRaw: no retry and no stall
      // accounting on the way out - a teardown that stands a replacement relay up
      // only to drop it again is worse than a teardown that gives up. The race
      // below is the only budget it gets.
      //
      // First the tabs THIS bridge opened, each matched by the URL it was opened
      // on (newest first), so a tab the user opened meanwhile is never closed. A
      // tab that navigated away no longer matches and is left open - the safe
      // failure in someone else's browser.
      //
      // Then the tab we opened to work in (see ownWorkingTab), and finally the
      // connect.html tab(s) our relays opened (see CLIENT_NAME) - including any
      // left by an earlier file whose teardown died. Oldest first, so ours (the
      // newest, and the one whose closing drops this relay) goes last.
      const sweep = callRaw(
        `async (page) => {
           ${CLOSE_SAFE_SRC}
           const wanted = ${JSON.stringify(openedTabUrls)};
           const ps = page.context().pages();
           for (const url of wanted) {
             for (let i = ps.length - 1; i >= 0; i--) {
               const p = ps[i];
               if (!p || p === page || !p.url().startsWith(url)) continue;
               await closeSafe(p);
               ps[i] = null;
               break;
             }
           }
           ${ownWorkingTab ? "await closeSafe(page);" : ""}
           ${RELAY_TAB_SWEEP_SRC(false)}
         }`,
      ).catch(() => {});
      openedTabUrls = [];
      await Promise.race([sweep, new Promise((r) => setTimeout(r, CONNECT_TAB_CLOSE_MS))]);
      await dispose();
    },
  };
}
