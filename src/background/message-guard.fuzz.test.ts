// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generated input for the extension's one trust boundary. message-guard.test.ts pins the
// cases we thought of; this file states the rules that must hold for the ones we did not -
// a content script on a supported page can send ANY value here, and the only thing standing
// between that and the service worker's stores is this parser.
//
// A red run here is a real counterexample, not flake: fast-check prints the failing value and
// the seed that produced it, and `fc.assert(..., { seed, path })` replays it exactly.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { EMAIL_MAX, NOTE_MAX, OTP_CODE_MAX, type RuntimeMessage, TITLE_MAX } from "../shared/messages";
import { ALL_SITES } from "../shared/sites";
import { HOSTILE_STRINGS, HOSTILE_VALUES } from "../test/hostile-inputs";
import { FETCH_LIMIT_MAX, HISTORY_PAGE_LIMIT_MAX, HISTORY_QUERY_MAX, parseRuntimeMessage, TARGET_COUNT_MAX } from "./message-guard";

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXT_BASE = `chrome-extension://${RUNTIME_ID}/`;

// The github content script's frame: a real supported host, so `senderSite` resolves and the
// target gate has something to compare against.
const SENDER_SITE = "github";
const contentScript = (overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender => ({ id: RUNTIME_ID, tab: { id: 7 }, url: "https://github.com/owner/repo", ...overrides }) as chrome.runtime.MessageSender;
const extensionPage = (): chrome.runtime.MessageSender => ({ id: RUNTIME_ID, url: `${EXT_BASE}popup.html` }) as chrome.runtime.MessageSender;

const CONTENT_SCRIPT_TYPES = ["vote", "fetchCount", "ui:injected"] as const;
const EXTENSION_PAGE_TYPES = ["report", "history:page", "history:stats", "history:export", "history:import", "auth:signOut", "auth:delete", "auth:requestOtp", "auth:verifyOtp"] as const;
const ALL_TYPES = [...CONTENT_SCRIPT_TYPES, ...EXTENSION_PAGE_TYPES, "auth:status", "auth:openTab"] as const;

// Values worth putting in a field: fast-check's own spread, plus the fixed corpus so the
// known-nasty vectors are tried on every run rather than only when the generator finds them.
const hostile = fc.oneof(fc.constantFrom(...HOSTILE_STRINGS), fc.constantFrom(...(HOSTILE_VALUES as unknown[])), fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true }));

/** Hostile OR plausible, weighted so the accepted path is reached often. Fully random fields
 *  would be rejected on the first one every time, and every "accepted messages satisfy X"
 *  property below would pass by never seeing an accepted message. */
const maybeValid = <T>(...valid: T[]) => fc.oneof({ arbitrary: fc.constantFrom(...valid) as fc.Arbitrary<unknown>, weight: 3 }, { arbitrary: hostile, weight: 2 });

// The sender runs on github.com, so this is the one target shape the guard can accept from it.
const VALID_TARGET = { site: SENDER_SITE, targetId: "owner/repo", url: "https://github.com/owner/repo" };

// A message shaped like the real thing, each field independently either plausible or hostile -
// the space a plain `fc.anything()` never reaches, because it neither guesses a valid `type`
// nor assembles a target that survives the site gate.
const shapedMessage = fc.record(
  {
    type: fc.constantFrom(...ALL_TYPES),
    target: fc.oneof({ arbitrary: fc.constant(VALID_TARGET) as fc.Arbitrary<unknown>, weight: 3 }, { arbitrary: fc.record({ site: maybeValid(...ALL_SITES), targetId: maybeValid("owner/repo"), url: maybeValid("https://github.com/owner/repo") }), weight: 2 }, { arbitrary: hostile, weight: 1 }),
    reaction: maybeValid("👍", "❤️", null),
    prevReaction: maybeValid("👍", null),
    title: maybeValid("A repository", "x".repeat(TITLE_MAX)),
    note: maybeValid("It mounts twice", "x".repeat(NOTE_MAX)),
    lang: maybeValid("en-US", "uk"),
    site: maybeValid(...ALL_SITES),
    host: maybeValid("github.com"),
    url: maybeValid("https://github.com/owner/repo"),
    targetCount: maybeValid(0, 1, TARGET_COUNT_MAX),
    limit: maybeValid(1, 25, FETCH_LIMIT_MAX, HISTORY_PAGE_LIMIT_MAX),
    cursor: maybeValid(1, 4096),
    query: maybeValid("cats", "x".repeat(HISTORY_QUERY_MAX)),
    since: maybeValid(0, 1_700_000_000_000),
    emoji: maybeValid("👍"),
    email: maybeValid("a@b.example"),
    code: maybeValid("123456"),
    rows: fc.oneof(
      hostile,
      fc.array(fc.oneof(hostile, fc.record({ site: maybeValid(...ALL_SITES), targetId: maybeValid("owner/repo"), targetUrl: maybeValid("https://github.com/owner/repo"), reaction: maybeValid("👍"), ts: maybeValid(0, 1_700_000_000_000), action: maybeValid("add", "remove", "change") })), { maxLength: 5 }),
    ),
  },
  { requiredKeys: ["type"] },
);

/** Runs a property over shapedMessage and fails if it never saw an accepted message: every
 *  "an accepted message satisfies X" check below is vacuous without one. */
function overAcceptedMessages(sender: chrome.runtime.MessageSender, check: (parsed: RuntimeMessage, raw: Record<string, unknown>) => void): void {
  let accepted = 0;
  fc.assert(
    fc.property(shapedMessage, (raw) => {
      const parsed = parseRuntimeMessage(raw, sender, RUNTIME_ID, EXT_BASE);
      if (!parsed) return;
      accepted += 1;
      check(parsed, raw as Record<string, unknown>);
    }),
    { numRuns: 300 },
  );
  expect(accepted, "the generator produced no accepted message - the property proved nothing").toBeGreaterThan(0);
}

/** Every bound the parser promises its callers, checked on whatever it let through. The
 *  background writes these straight into IndexedDB and the API request body. */
function expectWithinDeclaredBounds(msg: RuntimeMessage): void {
  const m = msg as Record<string, unknown>;
  const atMost = (field: string, max: number) => {
    const value = m[field];
    if (typeof value === "string") expect(value.length, `${msg.type}.${field}`).toBeLessThanOrEqual(max);
  };
  atMost("title", TITLE_MAX);
  atMost("note", NOTE_MAX);
  atMost("query", HISTORY_QUERY_MAX);
  atMost("email", EMAIL_MAX);
  atMost("code", OTP_CODE_MAX);

  const inRange = (field: string, min: number, max: number) => {
    const value = m[field];
    if (value === undefined) return;
    expect(typeof value, `${msg.type}.${field}`).toBe("number");
    expect(Number.isSafeInteger(value), `${msg.type}.${field} = ${String(value)}`).toBe(true);
    expect(value as number, `${msg.type}.${field}`).toBeGreaterThanOrEqual(min);
    expect(value as number, `${msg.type}.${field}`).toBeLessThanOrEqual(max);
  };
  inRange("targetCount", 0, TARGET_COUNT_MAX);
  inRange("limit", 1, msg.type === "history:page" ? HISTORY_PAGE_LIMIT_MAX : FETCH_LIMIT_MAX);
  inRange("cursor", 1, Number.MAX_SAFE_INTEGER);
  inRange("since", 0, Number.MAX_SAFE_INTEGER);
}

describe("parseRuntimeMessage under generated input", () => {
  // A throw here does not reject the message - it escapes the onMessage listener, so no reply
  // is ever sent and the content script's promise hangs forever.
  it("returns a verdict for anything at all, never throws", () => {
    fc.assert(
      fc.property(fc.oneof(shapedMessage, hostile), fc.constantFrom(contentScript(), extensionPage(), {} as chrome.runtime.MessageSender), (raw, sender) => {
        parseRuntimeMessage(raw, sender, RUNTIME_ID, EXT_BASE);
      }),
    );
  });

  it("only ever returns the type it was asked for, and only a known one", () => {
    overAcceptedMessages(contentScript(), (parsed, raw) => {
      expect(ALL_TYPES).toContain(parsed.type);
      expect(parsed.type).toBe(raw.type);
    });
  });

  it("holds every accepted field inside its declared bound", () => {
    overAcceptedMessages(contentScript(), expectWithinDeclaredBounds);
    overAcceptedMessages(extensionPage(), expectWithinDeclaredBounds);
  });

  it("never lets a content script reach an extension-page type", () => {
    fc.assert(
      fc.property(shapedMessage, (raw) => {
        const parsed = parseRuntimeMessage({ ...raw, type: fc.sample(fc.constantFrom(...EXTENSION_PAGE_TYPES), 1)[0] }, contentScript(), RUNTIME_ID, EXT_BASE);
        expect(parsed).toBeNull();
      }),
    );
  });

  it("never accepts anything from another extension", () => {
    fc.assert(
      fc.property(fc.oneof(shapedMessage, hostile), (raw) => {
        expect(parseRuntimeMessage(raw, contentScript({ id: "someoneelse" }), RUNTIME_ID, EXT_BASE)).toBeNull();
      }),
    );
  });

  // The gate that keeps one compromised site from writing votes attributed to another: an
  // accepted target always names the site the sender actually runs on, over https, on a host
  // that belongs to that site.
  it("only accepts a target the sender is entitled to speak for", () => {
    let withTarget = 0;
    overAcceptedMessages(contentScript(), (parsed) => {
      const target = (parsed as { target?: { site: string; url: string } }).target;
      if (!target) return;
      withTarget += 1;
      expect(target.site).toBe(SENDER_SITE);
      expect(new URL(target.url).protocol).toBe("https:");
    });
    expect(withTarget, "no target-bearing message was accepted - the site gate was never exercised").toBeGreaterThan(0);
  });

  // The import path is the one place a target URL does not come from an adapter: it comes out
  // of a file the user was handed. Every accepted row must still be an https link to the site
  // it claims, because the popup renders it as a clickable link.
  it("holds imported history rows to the same target rules", () => {
    let rowsSeen = 0;
    // One malformed row rejects the WHOLE import, so a row here is hostile in one field at a
    // time - otherwise the odds of a fully valid batch are nil and the accepted path, the only
    // one with anything to assert, is never reached.
    const rowField = <T>(...valid: T[]) => fc.oneof({ arbitrary: fc.constantFrom(...valid) as fc.Arbitrary<unknown>, weight: 12 }, { arbitrary: hostile, weight: 1 });
    const row = fc.record({ site: rowField(...ALL_SITES), targetId: rowField("owner/repo"), targetUrl: rowField("https://github.com/owner/repo"), reaction: rowField("👍", "❤️"), ts: rowField(0, 1_700_000_000_000), action: rowField("add", "remove", "change") });
    fc.assert(
      fc.property(fc.array(fc.oneof({ arbitrary: row, weight: 8 }, { arbitrary: hostile, weight: 1 }), { minLength: 1, maxLength: 4 }), (rows) => {
        const parsed = parseRuntimeMessage({ type: "history:import", rows }, extensionPage(), RUNTIME_ID, EXT_BASE) as { rows?: Array<{ site: string; targetUrl: string; ts: number }> } | null;
        if (!parsed?.rows) return;
        for (const imported of parsed.rows) {
          rowsSeen += 1;
          expect(ALL_SITES).toContain(imported.site);
          expect(new URL(imported.targetUrl).protocol).toBe("https:");
          expect(Number.isSafeInteger(imported.ts) && imported.ts >= 0).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
    expect(rowsSeen, "no row was imported - the row parser was never exercised").toBeGreaterThan(0);
  });
});
