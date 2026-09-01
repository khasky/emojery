// SPDX-License-Identifier: GPL-3.0-or-later
//
// The web-page -> service-worker trust boundary, verified in a real browser.
// `message-guard.test.ts` unit-proves isTrustedSender; only a live browser can
// prove the extension exposes NO channel a web page could reach the service
// worker through in the first place. A regression that adds a broad
// `externally_connectable` (handing the page main world a chrome.runtime it could
// post vote / history:export / auth:delete through) would pass every unit test
// but fail here. No sign-in needed, so this runs without any test credentials.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import * as ext from "./lib/extension";

// `externally_connectable` is the only manifest key that lets a listed web origin
// call chrome.runtime.sendMessage(extId, ...) straight to the worker, bypassing
// the tab-bound / extension-page sender checks. The extension needs no such
// channel (all its messaging is content-script or own-page), so the key must be
// absent - or, if ever added, name no web matches and no external extension ids.
test("built manifest exposes no externally_connectable web-messaging channel", () => {
  const manifestPath = resolve(ext.resolveExtensionPath(), "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    externally_connectable?: { matches?: unknown[]; ids?: unknown[] };
  };
  const externallyConnectable = manifest.externally_connectable;
  expect(externallyConnectable?.matches ?? [], "no web origin may message the service worker").toEqual([]);
  expect(externallyConnectable?.ids ?? [], "no external extension may message the service worker").toEqual([]);
});

// On a live supported page the content script runs in its ISOLATED world; the
// page's MAIN world - where the site's own JS, and any attacker script injected
// into it, lives - must be unable to drive the worker's privileged handlers. We
// evaluate in the main world and forge the two most damaging messages
// (auth:delete, history:export); without externally_connectable Chrome finds no
// receiving end, so each send rejects and no RuntimeResponse comes back.
test("a forged runtime message from a supported page never reaches the service worker", async () => {
  // No env gate: this is a CI trust-boundary gate, so a misconfigured harness
  // must fail loudly (openGithub -> envUrl throws) rather than skip into green.
  const session = await ext.launchSession();
  try {
    const extensionId = await ext.resolveExtensionId(session.context);
    expect(extensionId, "Emojery must be loaded before the boundary check").not.toBeNull();
    if (!extensionId) return;

    const page = await ext.openGithub(session.context);
    const outcome = await page.evaluate(async (extId) => {
      const runtime = (globalThis as { chrome?: { runtime?: { sendMessage?: (id: string, message: unknown) => Promise<unknown> } } }).chrome?.runtime;
      if (!runtime || typeof runtime.sendMessage !== "function") {
        return { channel: false as const };
      }
      const attempts: Array<{ type: string; response: unknown }> = [];
      for (const message of [{ type: "auth:delete" }, { type: "history:export" }]) {
        try {
          const response = await runtime.sendMessage(extId, message);
          attempts.push({ type: message.type, response: response ?? null });
        } catch {
          // Rejected send = no receiving end = boundary held.
          attempts.push({ type: message.type, response: null });
        }
      }
      return { channel: true as const, attempts };
    }, extensionId);

    // No web-messaging API in the page world at all is itself a held boundary.
    if (!outcome.channel) return;
    for (const attempt of outcome.attempts) {
      expect(attempt.response, `forged ${attempt.type} must get no response from the service worker`).toBeNull();
    }
  } finally {
    await ext.closeSession(session);
  }
});
