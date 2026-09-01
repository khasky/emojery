// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { EMAIL_MAX, NOTE_MAX, OTP_CODE_MAX, REACTION_BYTES_MAX, type RuntimeMessage } from "../shared/messages";
import { FETCH_LIMIT_MAX, HISTORY_PAGE_LIMIT_MAX, HISTORY_QUERY_MAX, isExtensionPageSender, isTrustedSender, parseRuntimeMessage, TARGET_COUNT_MAX } from "./message-guard";

const RUNTIME_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXT_BASE = `chrome-extension://${RUNTIME_ID}/`;

// Exactly one over the limit: the boundary itself is what every rejection case
// below probes, so the string is derived from the guard's own constant.
const overLimit = (max: number): string => "x".repeat(max + 1);

function sender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return { id: RUNTIME_ID, ...overrides } as chrome.runtime.MessageSender;
}

// A tab-bound sender, as Chrome populates for content-script messages.
function tabSender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return sender({
    tab: { id: 7 } as chrome.tabs.Tab,
    url: "https://github.com/owner/repo",
    ...overrides,
  });
}

// An extension-page sender (popup, or auth.html running in a tab).
function pageSender(overrides: Partial<chrome.runtime.MessageSender> = {}): chrome.runtime.MessageSender {
  return sender({ url: `${EXT_BASE}popup.html`, ...overrides });
}

const CONTENT_SCRIPT_TYPES: RuntimeMessage["type"][] = ["vote", "fetchCount", "ui:injected"];

const EXTENSION_PAGE_TYPES: RuntimeMessage["type"][] = ["report", "history:page", "history:stats", "history:export", "history:import", "auth:signOut", "auth:delete", "auth:requestOtp", "auth:verifyOtp"];

const SHARED_TYPES: RuntimeMessage["type"][] = ["auth:status", "auth:openTab"];

describe("isTrustedSender", () => {
  it("rejects any message whose sender is a different extension", () => {
    for (const type of [...CONTENT_SCRIPT_TYPES, ...EXTENSION_PAGE_TYPES, ...SHARED_TYPES]) {
      expect(isTrustedSender(type, tabSender({ id: "someoneelse" }), RUNTIME_ID, EXT_BASE)).toBe(false);
    }
  });

  it("rejects a message with no sender id (foreign / untrusted origin)", () => {
    const noId = {} as chrome.runtime.MessageSender;
    expect(isTrustedSender("vote", noId, RUNTIME_ID, EXT_BASE)).toBe(false);
    expect(isTrustedSender("report", noId, RUNTIME_ID, EXT_BASE)).toBe(false);
  });

  it("accepts content-script messages only when tab-bound", () => {
    for (const type of CONTENT_SCRIPT_TYPES) {
      expect(isTrustedSender(type, tabSender(), RUNTIME_ID, EXT_BASE)).toBe(true);
      // Same extension but no tab, so it looks like a forged page-to-SW message.
      expect(isTrustedSender(type, sender(), RUNTIME_ID, EXT_BASE)).toBe(false);
    }
  });

  it("treats a tab without an id as not tab-bound", () => {
    const tablessTab = sender({ tab: {} as chrome.tabs.Tab });
    expect(isTrustedSender("vote", tablessTab, RUNTIME_ID, EXT_BASE)).toBe(false);
  });

  it("accepts extension-page messages from the popup (no tab)", () => {
    for (const type of EXTENSION_PAGE_TYPES) {
      expect(isTrustedSender(type, pageSender(), RUNTIME_ID, EXT_BASE)).toBe(true);
    }
  });

  it("accepts extension-page messages from an extension page opened in a tab", () => {
    const authTab = pageSender({
      tab: { id: 7 } as chrome.tabs.Tab,
      url: `${EXT_BASE}auth.html`,
    });
    for (const type of EXTENSION_PAGE_TYPES) {
      expect(isTrustedSender(type, authTab, RUNTIME_ID, EXT_BASE)).toBe(true);
    }
  });

  it("rejects extension-page messages from content-script (web-page) senders", () => {
    for (const type of EXTENSION_PAGE_TYPES) {
      expect(isTrustedSender(type, tabSender(), RUNTIME_ID, EXT_BASE)).toBe(false);
      expect(isTrustedSender(type, sender(), RUNTIME_ID, EXT_BASE)).toBe(false);
    }
  });

  it("accepts shared types from both content scripts and extension pages", () => {
    for (const type of SHARED_TYPES) {
      expect(isTrustedSender(type, tabSender(), RUNTIME_ID, EXT_BASE)).toBe(true);
      expect(isTrustedSender(type, pageSender(), RUNTIME_ID, EXT_BASE)).toBe(true);
    }
  });
});

// A web page controls its own URL - path, query and fragment - and the content script the
// extension injects into a supported site messages with THAT url as `sender.url`. So a page
// can put the extension's own base anywhere but the front, and a check that merely looked
// for the base somewhere in the string would hand it the extension-page types: `report`,
// the history store, and the OTP pair that MINTS a credential.
describe("isExtensionPageSender is anchored at the start of the URL", () => {
  const smuggled = [
    `https://www.facebook.com/watch/?u=${EXT_BASE}popup.html`,
    `https://github.com/owner/repo#${EXT_BASE}`,
    `https://x.com/${EXT_BASE}`,
    // The base as an origin-lookalike host, so even the scheme reads right mid-string.
    `https://evil.example/redirect?to=${EXT_BASE}auth.html`,
  ];

  it("rejects a web URL that merely contains the extension base", () => {
    for (const url of smuggled) {
      expect(isExtensionPageSender(sender({ url }), EXT_BASE), url).toBe(false);
    }
  });

  it("keeps the OTP exchange out of reach of such a sender", () => {
    for (const url of smuggled) {
      for (const type of EXTENSION_PAGE_TYPES) {
        expect(isTrustedSender(type, sender({ url, tab: { id: 7 } as chrome.tabs.Tab }), RUNTIME_ID, EXT_BASE), `${type} <- ${url}`).toBe(false);
      }
    }
  });

  it("still accepts a real extension page under the base", () => {
    expect(isExtensionPageSender(sender({ url: `${EXT_BASE}popup.html` }), EXT_BASE)).toBe(true);
    expect(isExtensionPageSender(sender({ url: `${EXT_BASE}auth.html?flow=signin` }), EXT_BASE)).toBe(true);
  });

  // Another extension's page, whose id shares a prefix with ours only after the `://`.
  it("rejects a page hosted by a different extension id", () => {
    expect(isExtensionPageSender(sender({ url: "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/popup.html" }), EXT_BASE)).toBe(false);
  });

  it("trusts nobody when the base URL is unknown", () => {
    // getURL("") is empty in a context without a runtime id; an empty prefix matches
    // every string, so the length check is what stops a blanket accept.
    expect(isExtensionPageSender(sender({ url: `${EXT_BASE}popup.html` }), "")).toBe(false);
    expect(isExtensionPageSender(sender({ url: "https://www.facebook.com/" }), "")).toBe(false);
  });

  it("rejects a sender with no URL at all", () => {
    expect(isExtensionPageSender(sender(), EXT_BASE)).toBe(false);
  });
});

// The JWT (and the account email) must never reach a web page or content script.
// The `auth:status` reply is the one place identity could leak. This half locks
// the predicate the handler gates email on; the handler's own reply is asserted
// behaviorally in message-router.test.ts ("the auth:status handler gates email
// and never returns the JWT").
describe("auth:status identity isolation", () => {
  it("withholds email from a content-script sender, allows it only from an extension page", () => {
    expect(isExtensionPageSender(tabSender(), EXT_BASE)).toBe(false);
    expect(isExtensionPageSender(pageSender(), EXT_BASE)).toBe(true);
    // An extension-id-shaped url that isn't the real base must not count as a page.
    expect(isExtensionPageSender(sender({ url: "chrome-extension://someoneelse/popup.html" }), EXT_BASE)).toBe(false);
    // Empty base (unknown extension origin) never grants email.
    expect(isExtensionPageSender(pageSender(), "")).toBe(false);
  });
});

describe("parseRuntimeMessage", () => {
  const target = {
    site: "github",
    targetId: "owner/repo/issues/1",
    url: "https://github.com/owner/repo/issues/1",
  };

  it("accepts a valid content-script vote message", () => {
    expect(
      parseRuntimeMessage(
        {
          type: "vote",
          target,
          reaction: "👍",
          prevReaction: null,
          lang: "en_US",
        },
        tabSender(),
        RUNTIME_ID,
        EXT_BASE,
      ),
    ).toEqual({
      type: "vote",
      target,
      reaction: "👍",
      prevReaction: null,
      lang: "en-US",
    });
  });

  it("rejects content-script payloads without a tab-bound sender", () => {
    expect(parseRuntimeMessage({ type: "fetchCount", target, limit: 10 }, sender(), RUNTIME_ID, EXT_BASE)).toBeNull();
  });

  it("rejects unknown message types before routing", () => {
    expect(parseRuntimeMessage({ type: "debug:dump" }, sender(), RUNTIME_ID, EXT_BASE)).toBeNull();
  });

  it("accepts a history page request with and without paging fields", () => {
    expect(parseRuntimeMessage({ type: "history:page" }, pageSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "history:page" });
    expect(parseRuntimeMessage({ type: "history:page", cursor: 42, limit: 100, query: "facebook" }, pageSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "history:page", cursor: 42, limit: 100, query: "facebook" });
  });

  it("rejects malformed history paging fields", () => {
    expect(parseRuntimeMessage({ type: "history:page", cursor: 0 }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:page", cursor: 1.5 }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:page", limit: 0 }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:page", limit: HISTORY_PAGE_LIMIT_MAX + 1 }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:page", query: 7 }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:page", query: overLimit(HISTORY_QUERY_MAX) }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
  });

  it("rejects unsupported sites and non-https target URLs", () => {
    expect(
      parseRuntimeMessage(
        {
          type: "fetchCount",
          target: { ...target, site: "bank" },
        },
        tabSender(),
        RUNTIME_ID,
        EXT_BASE,
      ),
    ).toBeNull();
    expect(
      parseRuntimeMessage(
        {
          type: "fetchCount",
          target: { ...target, url: "javascript:alert(1)" },
        },
        tabSender(),
        RUNTIME_ID,
        EXT_BASE,
      ),
    ).toBeNull();
    expect(
      parseRuntimeMessage(
        {
          type: "fetchCount",
          target: { ...target, url: "http://github.com/owner/repo/issues/1" },
        },
        tabSender(),
        RUNTIME_ID,
        EXT_BASE,
      ),
    ).toBeNull();
  });

  it("rejects malformed reactions and out-of-range fetch limits", () => {
    expect(
      parseRuntimeMessage(
        {
          type: "vote",
          target,
          reaction: overLimit(REACTION_BYTES_MAX),
          prevReaction: null,
        },
        tabSender(),
        RUNTIME_ID,
        EXT_BASE,
      ),
    ).toBeNull();
    expect(parseRuntimeMessage({ type: "fetchCount", target, limit: FETCH_LIMIT_MAX + 1 }, tabSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
  });

  // A padded emoji is a distinct key everywhere downstream (vote body, history,
  // recents, own-reaction clear), and the History facet chips only ever match the
  // trimmed form - so the trim has to happen at the boundary.
  it("normalizes a padded reaction to the trimmed emoji", () => {
    expect(parseRuntimeMessage({ type: "vote", target, reaction: " 👍 ", prevReaction: "\t❤️\n" }, tabSender(), RUNTIME_ID, EXT_BASE)).toMatchObject({ reaction: "👍", prevReaction: "❤️" });
  });

  it("accepts valid report messages but rejects oversized notes", () => {
    expect(
      parseRuntimeMessage(
        {
          type: "report",
          site: "github",
          host: "github.com",
          url: "https://github.com/owner/repo/issues/1",
          targetCount: 1,
          note: "broken placement",
        },
        pageSender(),
        RUNTIME_ID,
        EXT_BASE,
      ),
    ).toMatchObject({ type: "report", note: "broken placement" });
    expect(
      parseRuntimeMessage(
        {
          type: "report",
          site: "github",
          host: "github.com",
          url: "https://github.com/owner/repo/issues/1",
          targetCount: 1,
          note: overLimit(NOTE_MAX),
        },
        pageSender(),
        RUNTIME_ID,
        EXT_BASE,
      ),
    ).toBeNull();
  });

  it("validates ui injection counters", () => {
    expect(parseRuntimeMessage({ type: "ui:injected", targetCount: 2 }, tabSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "ui:injected", targetCount: 2 });
    // The badge count is the whole payload: a target the router never reads must not ride along.
    expect(parseRuntimeMessage({ type: "ui:injected", targetCount: 2, target }, tabSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "ui:injected", targetCount: 2 });
    expect(parseRuntimeMessage({ type: "ui:injected", targetCount: TARGET_COUNT_MAX + 1 }, tabSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
  });

  it("accepts history facet fields and a stats request", () => {
    expect(parseRuntimeMessage({ type: "history:page", site: "github", emoji: "❤️", since: 1000 }, pageSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "history:page", site: "github", emoji: "❤️", since: 1000 });
    expect(parseRuntimeMessage({ type: "history:page", site: "bank" }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:page", since: -1 }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:stats" }, pageSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "history:stats" });
  });

  it("accepts a valid history import and rejects any malformed row", () => {
    const row = { site: "github", targetId: "owner/repo/issues/1", targetUrl: "https://github.com/owner/repo/issues/1", reaction: "❤️", ts: 1000, action: "add" };
    expect(parseRuntimeMessage({ type: "history:import", rows: [row] }, pageSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "history:import", rows: [row] });
    const noAction = { site: "github", targetId: "x", targetUrl: "https://github.com/x", reaction: "🔥", ts: 5 };
    expect(parseRuntimeMessage({ type: "history:import", rows: [noAction] }, pageSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "history:import", rows: [noAction] });
    // One bad row rejects the whole import: missing ts, bad action, non-https, non-array.
    expect(parseRuntimeMessage({ type: "history:import", rows: [row, { site: "github", targetId: "x", targetUrl: "https://github.com/x", reaction: "❤️" }] }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:import", rows: [{ ...row, action: "sideways" }] }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:import", rows: [{ ...row, targetUrl: "http://github.com/x" }] }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    // An import file is the one target URL the adapters never produced: a row
    // pointing off-site would render as a GitHub-labelled link to anywhere.
    expect(parseRuntimeMessage({ type: "history:import", rows: [{ ...row, targetUrl: "https://evil.example/x" }] }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    // A parse-only host (bare facebook.com) still imports - older exports carry it.
    const bareHostRow = { site: "facebook", targetId: "post:1", targetUrl: "https://facebook.com/zuck/posts/1", reaction: "❤️", ts: 1000 };
    expect(parseRuntimeMessage({ type: "history:import", rows: [bareHostRow] }, pageSender(), RUNTIME_ID, EXT_BASE)).toEqual({ type: "history:import", rows: [bareHostRow] });
    expect(parseRuntimeMessage({ type: "history:import", rows: [{ ...row, site: "bank" }] }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "history:import", rows: "nope" }, pageSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
  });

  // Each content script runs on exactly one site, so a target naming a different
  // one can only come from a sender speaking outside its own frame.
  it("rejects a target claiming a site the sender does not run on", () => {
    const redditTarget = { site: "reddit", targetId: "t3_abc", url: "https://www.reddit.com/r/x/comments/abc/" };
    const redditSender = tabSender({ url: "https://www.reddit.com/r/x/comments/abc/" });
    for (const type of ["vote", "fetchCount"] as const) {
      const payload = { type, target: redditTarget, reaction: "👍", prevReaction: null };
      // Default tabSender() is a github frame - the mismatch must reject.
      expect(parseRuntimeMessage(payload, tabSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
      // The identical payload from the matching frame goes through.
      expect(parseRuntimeMessage(payload, redditSender, RUNTIME_ID, EXT_BASE)).toMatchObject({ type, target: redditTarget });
    }
  });

  // The adapters only ever emit a canonical on-site URL, so an off-site one can
  // only come from a sender that built the message itself.
  it("rejects a target URL hosted off the claimed site", () => {
    for (const type of ["vote", "fetchCount"] as const) {
      const payload = { type, target: { ...target, url: "https://evil.example/owner/repo" }, reaction: "👍", prevReaction: null };
      expect(parseRuntimeMessage(payload, tabSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    }
  });

  it("rejects a target-bearing message whose sender frame has no readable supported host", () => {
    expect(parseRuntimeMessage({ type: "fetchCount", target }, tabSender({ url: "https://not-a-supported-site.example/x" }), RUNTIME_ID, EXT_BASE)).toBeNull();
    // A tab-bound sender Chrome populated no url for.
    const urlless = sender({ tab: { id: 7 } as chrome.tabs.Tab });
    expect(parseRuntimeMessage({ type: "fetchCount", target }, urlless, RUNTIME_ID, EXT_BASE)).toBeNull();
  });

  it("rejects history import/export/stats from a content-script sender", () => {
    for (const type of ["history:stats", "history:export", "history:import"] as const) {
      expect(parseRuntimeMessage({ type, rows: [] }, tabSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    }
  });

  // The OTP pair is the one exchange that mints a session, so the sender gate
  // matters more here than anywhere else: a compromised content script that could
  // drive it would be requesting and redeeming codes for arbitrary addresses.
  it("accepts the OTP exchange from the auth page and refuses it from a content script", () => {
    const authPage = pageSender({ url: `${EXT_BASE}auth.html` });
    expect(parseRuntimeMessage({ type: "auth:requestOtp", email: "a@b.com" }, authPage, RUNTIME_ID, EXT_BASE)).toEqual({ type: "auth:requestOtp", email: "a@b.com" });
    expect(parseRuntimeMessage({ type: "auth:verifyOtp", email: "a@b.com", code: "123456" }, authPage, RUNTIME_ID, EXT_BASE)).toEqual({ type: "auth:verifyOtp", email: "a@b.com", code: "123456" });

    expect(parseRuntimeMessage({ type: "auth:requestOtp", email: "a@b.com" }, tabSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
    expect(parseRuntimeMessage({ type: "auth:verifyOtp", email: "a@b.com", code: "123456" }, tabSender(), RUNTIME_ID, EXT_BASE)).toBeNull();
  });

  it("holds the OTP fields to a present, bounded string", () => {
    const authPage = pageSender({ url: `${EXT_BASE}auth.html` });
    const reject = (raw: unknown) => expect(parseRuntimeMessage(raw, authPage, RUNTIME_ID, EXT_BASE)).toBeNull();

    reject({ type: "auth:requestOtp" });
    reject({ type: "auth:requestOtp", email: "" });
    reject({ type: "auth:requestOtp", email: "   " });
    reject({ type: "auth:requestOtp", email: 42 });
    reject({ type: "auth:requestOtp", email: `${"a".repeat(EMAIL_MAX + 1 - "@example.com".length)}@example.com` }); // EMAIL_MAX + 1 chars
    reject({ type: "auth:verifyOtp", email: "a@b.com" });
    reject({ type: "auth:verifyOtp", email: "a@b.com", code: "" });
    reject({ type: "auth:verifyOtp", email: "a@b.com", code: "1".repeat(OTP_CODE_MAX + 1) });
  });
});
