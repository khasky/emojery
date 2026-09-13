// SPDX-License-Identifier: GPL-3.0-or-later
//
// The background's `chrome.runtime.onMessage` router: one handler per message type,
// each answering with a `RuntimeResponse`. The boolean it returns is Chrome's
// keep-the-channel-open contract - `ANSWERED_NOW` on an async path closes the port
// and the sender's promise rejects. Every payload has already passed
// `parseRuntimeMessage` (message-guard.ts), the trust boundary that also decides
// which sender may send which type; nothing below re-validates.
import { defined } from "../shared/defined";
import { EMPTY_HISTORY_STATS, type RuntimeMessage, type RuntimeResponse } from "../shared/messages";
import { setCachedCounts, targetKey } from "../shared/storage";
import { createTab } from "../shared/webext";
import { enqueueVote, flushOwnedVotesForSignOut, getFlushState } from "./api";
import { apiErrorCode } from "./api-client";
import { fetchCount } from "./api-read";
import { hasAuthOrigin, rememberAuthOrigin, returnToAuthOrigin } from "./auth-return";
import { logBackgroundError } from "./debug";
import { exportHistory, getHistoryPage, getHistoryStats, importHistory } from "./history";
import { clearAuth, deleteAccount, getAuth, requestOtp, revokeSessionServerSide, verifyOtp } from "./identity";
import { isExtensionPageSender, parseRuntimeMessage } from "./message-guard";
import { reportProblem } from "./reports";
import { errorResponse, respondAuthed, respondWith } from "./respond";
import { setInjectedBadge } from "./toolbar-badge";
import { broadcastVoteDelta } from "./vote-sync";
import { listQueuedVotes, VOTE_QUEUE_MAX } from "./votequeue";

const AUTH_URL_PATH = "auth.html";

// Fallback page size; the popup always sends its own.
const DEFAULT_HISTORY_PAGE_LIMIT = 100;

const ANSWER_LATER = true;
const ANSWERED_NOW = false;

/** What a handler needs beyond its own payload. `extensionBaseUrl` is resolved
 *  once per message and shared with the guard, so the two can never disagree on
 *  what counts as one of the extension's own pages. */
interface HandlerContext {
  sender: chrome.runtime.MessageSender;
  sendResponse: (response: RuntimeResponse) => void;
  extensionBaseUrl: string;
}

type Handler<T extends RuntimeMessage["type"]> = (msg: Extract<RuntimeMessage, { type: T }>, ctx: HandlerContext) => boolean;

/** One entry per message type - the mapped key is what makes that exhaustive. */
type HandlerTable = { [T in RuntimeMessage["type"]]: Handler<T> };

function openAuthTab(sender: chrome.runtime.MessageSender): void {
  // The origin is recorded BEFORE the tab exists, so the auth page can never load
  // and ask where to go back to before the answer is written.
  void rememberAuthOrigin(sender)
    .catch((error: unknown) => logBackgroundError("rememberAuthOrigin", error))
    .then(() => createTab({ url: chrome.runtime.getURL(AUTH_URL_PATH) }))
    .catch((error: unknown) => logBackgroundError("openAuthTab", error));
}

const HANDLERS: HandlerTable = {
  "ui:injected": (msg, { sender, sendResponse }) => {
    // Narrowing, not a second gate: the guard rejects this type from a sender
    // with no tab id.
    const tabId = sender.tab?.id;
    if (tabId !== undefined) {
      setInjectedBadge(tabId, msg.targetCount);
    }
    sendResponse({ type: "ok" });
    return ANSWERED_NOW;
  },

  vote: (msg, { sender, sendResponse }) => {
    respondWith(sendResponse, "vote", async () => {
      const queued = await enqueueVote(
        defined({
          target: msg.target,
          reaction: msg.reaction,
          prevReaction: msg.prevReaction,
          lang: msg.lang,
          title: msg.title,
          ts: Date.now(),
        }),
      );
      // A DROPPED vote (signed out between the tab's auth gate and this
      // message) answers "error", not "ok": on "ok" the sending tab keeps an
      // optimistic reaction the server will never see.
      if (!queued) return errorResponse("unavailable", "vote");
      // Only after the vote is durably queued: the sending tab rolls its own
      // optimistic state back on the error response above, but that rollback
      // is local to that tab - a delta already fanned out to the others would
      // leave them showing a reaction that was never queued.
      void broadcastVoteDelta(sender.tab?.id, {
        target: msg.target,
        reaction: msg.reaction,
        prevReaction: msg.prevReaction,
      });
      return { type: "ok" };
    });
    return ANSWER_LATER;
  },

  fetchCount: (msg, { sendResponse }) => {
    const requestedAt = Date.now();
    respondWith(
      sendResponse,
      "fetchCount",
      async () => {
        const data = await fetchCount(msg.target, msg.limit);
        const key = targetKey(msg.target);
        const myReaction: string | null = data.myReaction ?? null;
        await setCachedCounts({ [key]: { value: data, myReaction } }, { skipIfCachedAfter: requestedAt });
        return { type: "count", data };
      },
      apiErrorCode,
    );
    return ANSWER_LATER;
  },

  report: (msg, { sendResponse }) => {
    // The response is deferred until the POST settles: answering "ok" before it landed showed
    // the user a sent report that never reached the server.
    respondWith(sendResponse, "report", async () => {
      const sent = await reportProblem(defined({ site: msg.site, host: msg.host, url: msg.url, targetCount: msg.targetCount, note: msg.note }));
      return sent ? { type: "ok" } : errorResponse("unavailable", "report");
    });
    return ANSWER_LATER;
  },

  "history:page": (msg, { sendResponse }) => {
    respondAuthed(
      sendResponse,
      { type: "history:page", items: [], cursor: null, authed: false },
      async (userId) => {
        const page = await getHistoryPage(
          userId,
          defined({
            limit: msg.limit ?? DEFAULT_HISTORY_PAGE_LIMIT,
            cursor: msg.cursor ?? null,
            query: msg.query,
            site: msg.site,
            emoji: msg.emoji,
            since: msg.since,
          }),
        );
        return { type: "history:page", items: page.items, cursor: page.cursor, authed: true };
      },
      "history:page",
    );
    return ANSWER_LATER;
  },

  "history:stats": (_msg, { sendResponse }) => {
    respondAuthed(
      sendResponse,
      { type: "history:stats", stats: EMPTY_HISTORY_STATS, authed: false },
      async (userId) => {
        const stats = await getHistoryStats(userId);
        return { type: "history:stats", stats, authed: true };
      },
      "history:stats",
    );
    return ANSWER_LATER;
  },

  "queue:snapshot": (_msg, { sendResponse }) => {
    respondWith(sendResponse, "queue:snapshot", async () => {
      const [votes, flush] = await Promise.all([listQueuedVotes(VOTE_QUEUE_MAX), getFlushState()]);
      return {
        type: "queue:snapshot",
        // Rebuilt field by field: a queued vote also carries its owner, the page
        // title and the language, none of which the Debug tab prints.
        votes: votes.map((vote) => defined({ id: vote.id, target: vote.target, reaction: vote.reaction, attempts: vote.attempts, nextAttemptAt: vote.nextAttemptAt })),
        flush: { nextAttemptAt: flush.nextAttemptAt, consecutiveFailures: flush.consecutiveFailures },
      };
    });
    return ANSWER_LATER;
  },

  "history:export": (_msg, { sendResponse }) => {
    respondAuthed(
      sendResponse,
      { type: "history:export", rows: [], authed: false },
      async (userId) => {
        const rows = await exportHistory(userId);
        return { type: "history:export", rows, authed: true };
      },
      "history:export",
    );
    return ANSWER_LATER;
  },

  "history:import": (msg, { sendResponse }) => {
    respondAuthed(
      sendResponse,
      { type: "history:import", imported: 0, replaced: 0, authed: false },
      async (userId) => {
        const { imported, replaced } = await importHistory(userId, msg.rows);
        return { type: "history:import", imported, replaced, authed: true };
      },
      "history:import",
    );
    return ANSWER_LATER;
  },

  "auth:status": (_msg, { sender, sendResponse, extensionBaseUrl }) => {
    // Content scripts only need the authed flag; the email stays on the
    // extension's own pages.
    const includeEmail = isExtensionPageSender(sender, extensionBaseUrl);
    respondWith(sendResponse, "auth:status", async () => {
      const auth = await getAuth();
      return { type: "auth:status", authed: auth !== null, userId: auth?.userId ?? null, email: includeEmail ? (auth?.email ?? null) : null };
    });
    return ANSWER_LATER;
  },

  "auth:openTab": (_msg, { sender, sendResponse }) => {
    openAuthTab(sender);
    sendResponse({ type: "ok" });
    return ANSWERED_NOW;
  },

  "auth:returnToOrigin": (_msg, { sender, sendResponse }) => {
    respondWith(sendResponse, "auth:returnToOrigin", async () => ((await returnToAuthOrigin(sender.tab?.id)) ? { type: "ok" } : errorResponse("unavailable", "auth:returnToOrigin")));
    return ANSWER_LATER;
  },

  "auth:signOut": (_msg, { sendResponse }) => {
    // Flush queued votes under the still-valid token first, so a vote cast just before sign-out
    // isn't dropped as "ownership changed" at the next flush.
    respondWith(sendResponse, "auth:signOut", async () => {
      await flushOwnedVotesForSignOut().catch((error: unknown) => logBackgroundError("signOutFlush", error));
      // Then kill the session server-side, while the token is still readable. Best-effort: a
      // failure here must not strand the user signed in, so the local clear below runs either
      // way.
      const auth = await getAuth().catch(() => null);
      if (auth) {
        const revoked = await revokeSessionServerSide(auth.token);
        if (!revoked) logBackgroundError("signOutRevoke", new Error("server-side session revocation failed"));
      }
      await clearAuth();
      return { type: "ok" };
    });
    return ANSWER_LATER;
  },

  "auth:delete": (_msg, { sendResponse }) => {
    respondWith(sendResponse, "auth:delete", async () => ((await deleteAccount()) ? { type: "ok" } : errorResponse("unavailable", "auth:delete")));
    return ANSWER_LATER;
  },

  "auth:requestOtp": (msg, { sendResponse }) => {
    respondWith(sendResponse, "auth:requestOtp", async () => ({ type: "auth:otpRequested", ...(await requestOtp(msg.email)) }));
    return ANSWER_LATER;
  },

  "auth:verifyOtp": (msg, { sendResponse }) => {
    // Rebuilt field by field, never spread: keeps the response to exactly these
    // fields even if VerifyOtpResult grows. The session lives in storage.local
    // (read by getAuth) and is never forwarded here.
    respondWith(sendResponse, "auth:verifyOtp", async () => {
      const res = await verifyOtp(msg.email, msg.code);
      if (!res.ok) return { type: "auth:otpVerified", ok: false, refusal: res.refusal };
      // A failed lookup must not fail the sign-in that already succeeded - it
      // costs the return offer, nothing more.
      const returnsToPage = await hasAuthOrigin().catch(() => false);
      return returnsToPage ? { type: "auth:otpVerified", ok: true, returnsToPage: true } : { type: "auth:otpVerified", ok: true };
    });
    return ANSWER_LATER;
  },
};

export function handleRuntimeMessage(raw: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: RuntimeResponse) => void): boolean {
  const extensionBaseUrl = chrome.runtime.getURL("");
  const msg = parseRuntimeMessage(raw, sender, chrome.runtime.id, extensionBaseUrl);
  if (!msg) return ANSWERED_NOW;
  // The one widening in this file: TypeScript cannot correlate the parameter of
  // `HANDLERS[msg.type]` with `msg` when the key is a union, even though the
  // mapped `HandlerTable` above guarantees they match. Narrowed by construction,
  // asserted in exactly this one place.
  const handler = HANDLERS[msg.type] as Handler<RuntimeMessage["type"]>;
  return handler(msg, { sender, sendResponse, extensionBaseUrl });
}
