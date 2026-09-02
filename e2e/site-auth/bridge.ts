// SPDX-License-Identifier: GPL-3.0-or-later
//
// Bridge to a REAL, human-launched Chrome: an MCP client to @playwright/mcp in
// --extension mode. The user starts the browser normally, so there is no automation
// launch fingerprint and no navigator.webdriver - only chrome.debugger attaches,
// like DevTools - which is why bot-sensitive platforms don't flag it. See the
// site-auth README.
//
// Two connection modes: in-process createConnection({ extension: true }) over an
// in-memory transport by default, or E2E_MCP_URL to reach an already-running server
// over streamable HTTP.
//
// All page interaction goes through browser_run_code_unsafe, which hands over a full
// Playwright page whose CSS engine pierces the open shadow roots the trigger/picker
// live in. Returned values are sentinel-wrapped JSON, parsed out of the MCP text
// envelope.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const SENTINEL = "<<SE>>";
const ERR_SENTINEL = "<<SE_ERR>>";

// Per-call ceiling. No body here legitimately runs this long, while the MCP SDK's
// own default is 60s - and since a stalled call is retried once, one stall cost 121s
// and blew straight past vitest's 120s hook budget.
const CALL_TIMEOUT_MS = 30_000;
// Lower than Playwright's 30s default, which would eat the whole call budget. Callers
// treat a failed goto as non-fatal and poll for the host afterwards.
const NAV_TIMEOUT_MS = 20_000;
// Navigation waits for commit alone, because a heavy logged-in permalink
// can stay readyState === "loading" for a minute (a Facebook /posts/ permalink: DOM
// complete only ~66s in), and every bridge call inflates while it streams, so a
// domcontentloaded goto blew the per-call budget and its -32001 retry doubled the
// loss. The hydrate wait below is a SEPARATE call, so a page that never settles costs
// one bounded call. Readiness comes from polling for a mounted host.
const HYDRATE_WAIT_MS = 10_000;
const HYDRATE_WAIT = `await page.waitForLoadState('domcontentloaded', { timeout: ${HYDRATE_WAIT_MS} }).catch(() => {});`;

// Rides at the head of every navigation (see Bridge.focusTab for why). A window the OS
// keeps minimized or fully covered stays hidden, and the harness diagnoses that when it
// happens.
const FOCUS_TAB_SRC = `await page.bringToFront().catch(() => {});`;

/**
 * Every failure this bridge produces, and nothing else. A bridge that stalled, lost
 * its relay or lost its tab has said nothing about the PAGE, and a helper that turns
 * one into a zero hands the reader "log into <site>" for an account that was signed
 * in. Helpers that observe rethrow these. Only side effects allowed to fail may
 * swallow one.
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

// No generic body ceiling: the only long-runner, page.mouse.wheel, is bounded at its
// call site (wheelBySrc in harness.ts).

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

// The page returns the sentinel, the json and the sentinel again. The envelope may
// print that raw or escaped, so try a direct parse then an unescape-once parse.
function parseSentinel<T>(text: string): T {
  const errAt = text.indexOf(ERR_SENTINEL);
  if (errAt >= 0) {
    throw new Error(`probe threw in page: ${text.slice(errAt + ERR_SENTINEL.length).slice(0, 300)}`);
  }
  // Newer @playwright/mcp renders the return value inside a "### Result" block where
  // the value is JSON-stringified, so a returned string arrives with its quotes
  // escaped and the raw sentinel scan below cannot parse it. Older builds inlined the
  // value, hence the fall back to the full text.
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
    // The envelope escaped the string one level. raw already carries those escapes
    // and goes between the quotes as-is: re-escaping its own quotes turned every \"
    // into \\" and made this branch throw on the exact shape it exists for.
    return JSON.parse(JSON.parse(`"${raw}"`)) as T;
  }
}

export interface Bridge {
  /** Commits, then makes ONE bounded domcontentloaded attempt whose failure is
   *  ignored. Readiness comes from polling for a host (see the header). Activates the
   *  tab first, as focusTab explains. */
  goto(url: string): Promise<void>;
  reload(): Promise<void>;
  /** Make the driven tab the ACTIVE one in its window. Emojery runs no scan while
   *  document.hidden and catches up on the next visibilitychange, so a backgrounded
   *  tab mounts nothing on any site - proven: reloading a background tab leaves 0
   *  hosts and 0 anchors, activating it mounts within a beat. goto/reload call this,
   *  so a run never measures a tab the user clicked away from. */
  focusTab(): Promise<void>;
  waitMs(ms: number): Promise<void>;
  /** Poll a predicate function body in-page until it holds or timeoutMs lapses.
   *  Prefer this over waitMs: the wait ends the moment the condition is met. */
  waitFor(predicateSource: string, timeoutMs: number): Promise<boolean>;
  /** page.evaluate of a probe source string (a function body with return). */
  evaluate<T>(probeSource: string): Promise<T>;
  press(key: string): Promise<void>;
  /** URLs of all open tabs - used to confirm we attached to the real browser. */
  tabUrls(): Promise<string[]>;
  /** Open a second tab. Callers address it as the LAST page (see close()). */
  openTab(url: string): Promise<void>;
  /** Escape hatch: a custom async (page) body that returns a value. */
  run<T>(returnExpr: string): Promise<T>;
  /** Escape hatch: a custom async (page) action body (no return). */
  act(body: string): Promise<void>;
  close(): Promise<void>;
}

// Our MCP client name, and the ONLY thing identifying the browser tab a connection
// leaves behind: establishing a bridge opens a connect.html tab carrying
// client={"name":<this>}, one per test file, and nothing on the Playwright side ever
// closes it. close() matches on this name so a connect page belonging to another
// Playwright client in the same browser is never touched.
const CLIENT_NAME = "emojery-siteauth";

// Closing our OWN connect page drops the relay mid-command, so that reply may never
// arrive. The wait is capped so a teardown never pays CALL_TIMEOUT_MS twice, once for
// the call and once for its retry.
const CONNECT_TAB_CLOSE_MS = 4_000;

// page.context().pages() lists ONLY the tabs of THIS bridge session - the relay's own
// connect.html page plus the tabs we opened - never the user's other tabs, and never
// another session's relay. Measured: 1 page right after connecting, 2 after opening the
// working tab. So:
//  - a leftover relay from a killed run is INVISIBLE here and can only be closed by hand.
//  - a "don't close the last tab" guard (pages().length <= 1) reads 1 exactly when
//    teardown reaches the relay - which is why every run left one connect.html tab per
//    test file standing.
// Only pages this bridge opened or matched by URL are ever passed to closeSafe, and the
// user's own tabs keep the window alive, so the close is unconditional.
const CLOSE_SAFE_SRC = `const closeSafe = async (p) => { try { await p.close(); } catch {} };`;

// Our relay tab(s), closed LAST on teardown: closing one drops the connection this
// call is riding on. Reads ctx because the working tab is already closed by then.
const RELAY_TAB_SWEEP_SRC = `const relays = ctx.pages().filter((p) => { const u = p.url(); return u.startsWith('chrome-extension://') && u.includes('/connect.html?') && u.includes(${JSON.stringify(CLIENT_NAME)}); });
   for (const p of relays) { await closeSafe(p); }`;

// Two @playwright/mcp defaults this bridge turns off:
//  - timeouts.settle (500ms) holds each reply until the page's triggered work quiets
//    down. This bridge times its own waits, so on a feed that never stops fetching
//    that hold becomes an open ceiling.
//  - snapshot.mode builds an accessibility snapshot for the reply, which
//    parseSentinel throws away, at a cost that grows with the DOM it walks.
// Median round-trip over 12 sequential no-op evaluates per site: defaults 545ms
// (github) / 523ms (x) / 1003ms (facebook); with both off, 8 / 8 / 7ms. The suite
// makes thousands of calls. Settle stays tunable per run.
const MCP_SPEED = {
  snapshot: { mode: "none" },
  timeouts: { settle: Number(process.env.E2E_MCP_SETTLE_MS ?? 0) },
} as const;

export async function connectBridge(): Promise<Bridge> {
  // URLs of the tabs THIS bridge opened, closed on teardown so a run leaves no
  // strays. Matched by URL, because this drives the USER's browser and a tab they open
  // mid-run would otherwise be the one teardown closes by position.
  let openedTabUrls: string[] = [];
  const client = new Client({ name: CLIENT_NAME, version: "1.0.0" });

  // When set, the bridge connects to an already-running server and spawns nothing.
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
    // @playwright/mcp reads PLAYWRIGHT_MCP_EXTENSION_TOKEN itself.
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

  // Why a call gets a second attempt: an SPA route change destroys the JS execution
  // context mid-call, or the relay answers past the MCP client's request timeout
  // (-32001), which a renderer busy with its own work causes routinely on a live feed.
  const isTransient = (e: unknown): boolean => /context was destroyed|Execution context|-32001|Request timed out/i.test(String(e));
  const ATTEMPTS = 2;
  const RETRY_PAUSE_MS = 1_500;

  // The ONE place a bridge failure is minted, so no caller can receive a raw McpError
  // and mistake it for something the page said.
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
      // A probe that threw is the PAGE talking and stays a plain error. An envelope
      // with no payload in it is the bridge failing to answer.
      if (String(e).includes("probe threw in page")) throw e;
      throw new BridgeError(`Site-auth bridge returned no readable payload: ${String(e).slice(0, 200)}`, { cause: e });
    }
  };

  // THE relay tab must never be the tab under test. With nothing selected in the
  // Playwright Extension, the relay hands its own connect.html page over as the page
  // under test, and navigating that page tears the relay down with it: every later
  // call then stalls into the per-call ceiling, for the whole run, on every site.
  //
  // So open a tab of our own and work there - browser_tabs makes the new tab the
  // current one, which is what moves the handle off the relay page. Recorded because
  // teardown closes it: a tab we opened is the only tab we may close blind. A relay
  // bound to a tab the user picked reads as a site URL - left alone, never closed.
  const ownWorkingTab = await runData<string>(`return page.url();`)
    .then(async (current) => {
      if (!/^chrome-extension:\/\/.*\/connect\.html\?/.test(current)) return false;
      await callTool("browser_tabs", { action: "new", url: "about:blank" });
      return true;
    })
    .catch(() => false);

  return {
    async goto(u) {
      await runAction(`${FOCUS_TAB_SRC} await page.goto(${JSON.stringify(u)}, { waitUntil: 'commit', timeout: ${NAV_TIMEOUT_MS} }).catch(() => {});`);
      await runAction(HYDRATE_WAIT);
    },
    async reload() {
      await runAction(`${FOCUS_TAB_SRC} await page.reload({ waitUntil: 'commit', timeout: ${NAV_TIMEOUT_MS} }).catch(() => {});`);
      await runAction(HYDRATE_WAIT);
    },
    async focusTab() {
      await runAction(FOCUS_TAB_SRC);
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
      // ONE call, straight through callRaw: no retry and no stall accounting on the
      // way out. The race below is the only budget it gets.
      //
      // First the tabs THIS bridge opened, matched by the URL they were opened on
      // (newest first), so a tab the user opened meanwhile is never closed. A tab that
      // navigated away no longer matches and is left open, which is the safe failure
      // in someone else's browser. Then the tab we opened to work in, and last our own
      // connect.html relay tab, whose closing drops the connection this call rides on.
      const sweep = callRaw(
        `async (page) => {
           const ctx = page.context();
           ${CLOSE_SAFE_SRC}
           const wanted = ${JSON.stringify(openedTabUrls)};
           const ps = ctx.pages();
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
           ${RELAY_TAB_SWEEP_SRC}
         }`,
      ).catch(() => {});
      openedTabUrls = [];
      await Promise.race([sweep, new Promise((r) => setTimeout(r, CONNECT_TAB_CLOSE_MS))]);
      await dispose();
    },
  };
}
