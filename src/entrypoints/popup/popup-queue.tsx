// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Debug tab (Settings -> Debug reveals it, in every build): what the durable vote queue
// holds and why it is sending nothing. Deliberately un-i18n'd - it prints raw queue internals
// for whoever is diagnosing them, and a translated `4 queued · hold 154s` helps nobody - and
// without CSS of its own (it borrows the History tab's rows). It asks the background for a
// snapshot over the message channel, like every other popup view: the queue is the
// service worker's store, and this page holds no connection of its own to it.
import { useEffect, useState } from "preact/hooks";
import { failureCode } from "../../shared/error-copy";
import type { FlushSnapshot, QueuedVoteRow } from "../../shared/messages";
import { HISTORY_CLASS, HISTORY_DAY_CLASS, HISTORY_EMOJI_CLASS, HISTORY_LINK_CLASS, HISTORY_MID_CLASS, HISTORY_TIME_CLASS, HISTORY_TITLE_CLASS } from "../../shared/page-dom";
import { sendRuntimeMessage } from "../../shared/webext";
import { EmojiImg } from "../../ui/emoji-img";
import { shortenUrl } from "./popup-shared";

// Fast enough to watch a backoff count down, slow enough to stay out of the way
// of the flush loop it is observing.
const REFRESH_MS = 1_000;
// The snapshot carries the whole (capped) queue; only the rendering is trimmed.
const VISIBLE_ROWS = 50;

const inSeconds = (ms: number): string => `${Math.max(0, Math.ceil(ms / 1000))}s`;

// What is keeping this vote from being sent: the queue-wide hold first (it gates
// every vote), then the vote's own backoff.
function waitLabel(vote: QueuedVoteRow, holdUntil: number, now: number): string {
  if (holdUntil > now) return `held ${inSeconds(holdUntil - now)}`;
  const own = vote.nextAttemptAt ?? 0;
  return own > now ? `retry ${inSeconds(own - now)}` : "ready";
}

const QueueView = () => {
  const [votes, setVotes] = useState<QueuedVoteRow[] | null>(null);
  const [flush, setFlush] = useState<FlushSnapshot | null>(null);
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const snapshot = await sendRuntimeMessage({ type: "queue:snapshot" });
        if (!live) return;
        if (snapshot?.type !== "queue:snapshot") throw new Error(failureCode(snapshot) ?? "no answer from the background");
        setVotes(snapshot.votes);
        setFlush(snapshot.flush);
        setNow(Date.now());
        setFailure(null);
      } catch (error: unknown) {
        if (live) setFailure(error instanceof Error ? error.message : String(error));
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  if (failure) {
    return (
      <section class={`${HISTORY_CLASS} empty`}>
        <p role="alert">{`Queue read failed: ${failure}`}</p>
      </section>
    );
  }
  if (!votes || !flush) return null;

  const holdUntil = flush.nextAttemptAt;
  const summary = [`${votes.length} queued`, holdUntil > now ? `hold ${inSeconds(holdUntil - now)}` : "no hold", `${flush.consecutiveFailures} consecutive failures`].join(" · ");

  return (
    <section class={HISTORY_CLASS}>
      <div class={HISTORY_DAY_CLASS}>{summary}</div>
      {/* No empty state: the summary above already reads "0 queued". */}
      {votes.length > 0 ? (
        <ul>
          {votes.slice(0, VISIBLE_ROWS).map((vote) => (
            <li key={vote.id}>
              {/* An unreact carries no reaction; the emoji it removes is the one the History row keeps. */}
              <span class={HISTORY_EMOJI_CLASS}>{vote.reaction ? <EmojiImg emoji={vote.reaction} /> : "✕"}</span>
              <div class={HISTORY_MID_CLASS}>
                <span class={HISTORY_LINK_CLASS}>{shortenUrl(vote.target.url)}</span>
                <span class={HISTORY_TITLE_CLASS}>{`#${vote.id} · ${vote.target.site} · ${vote.attempts} attempts`}</span>
              </div>
              <span class={HISTORY_TIME_CLASS}>{waitLabel(vote, holdUntil, now)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {votes.length > VISIBLE_ROWS ? <p class="row-hint">{`+${votes.length - VISIBLE_ROWS} more queued`}</p> : null}
    </section>
  );
};

export { QueueView };
