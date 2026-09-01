// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Debug tab (Settings -> Debug reveals it, in every build): what the durable vote queue
// holds and why it is sending nothing. Deliberately un-i18n'd - it prints raw queue internals
// for whoever is diagnosing them, and a translated `4 queued · hold 154s` helps nobody - and
// without CSS of its own (it borrows the History tab's rows). It reads the background's own
// modules rather than messaging it - same origin, so the reads hit the store the flush loop uses.
import { useEffect, useState } from "preact/hooks";
import { type FlushState, getFlushState } from "../../background/api";
import { listQueuedVotes, type StoredVote, VOTE_QUEUE_MAX } from "../../background/votequeue";
import { EmojiImg } from "../../ui/emoji-img";
import { shortenUrl } from "./popup-shared";

// Fast enough to watch a backoff count down, slow enough to stay out of the way
// of the flush loop it is observing.
const REFRESH_MS = 1_000;
// The queue itself is capped (VOTE_QUEUE_MAX), so the read is the whole truth;
// only the rendering is trimmed.
const VISIBLE_ROWS = 50;

const inSeconds = (ms: number): string => `${Math.max(0, Math.ceil(ms / 1000))}s`;

// What is keeping this vote from being sent: the queue-wide hold first (it gates
// every vote), then the vote's own backoff.
function waitLabel(vote: StoredVote, holdUntil: number, now: number): string {
  if (holdUntil > now) return `held ${inSeconds(holdUntil - now)}`;
  const own = vote.nextAttemptAt ?? 0;
  return own > now ? `retry ${inSeconds(own - now)}` : "ready";
}

const QueueView = () => {
  const [votes, setVotes] = useState<StoredVote[] | null>(null);
  const [flush, setFlush] = useState<FlushState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [failure, setFailure] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const load = async () => {
      try {
        const [queued, state] = await Promise.all([listQueuedVotes(VOTE_QUEUE_MAX), getFlushState()]);
        if (!live) return;
        setVotes(queued);
        setFlush(state);
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
      <section class="history empty">
        <p role="alert">{`Queue read failed: ${failure}`}</p>
      </section>
    );
  }
  if (!votes || !flush) return null;

  const holdUntil = flush.nextAttemptAt;
  const summary = [`${votes.length} queued`, holdUntil > now ? `hold ${inSeconds(holdUntil - now)}` : "no hold", `${flush.consecutiveFailures} consecutive failures`].join(" · ");

  return (
    <section class="history">
      <div class="history-day">{summary}</div>
      {/* No empty state: the summary above already reads "0 queued". */}
      {votes.length > 0 ? (
        <ul>
          {votes.slice(0, VISIBLE_ROWS).map((vote) => (
            <li key={vote.id}>
              {/* An unreact carries no reaction; the emoji it removes is the one the History row keeps. */}
              <span class="history-emoji">{vote.reaction ? <EmojiImg emoji={vote.reaction} /> : "✕"}</span>
              <div class="history-mid">
                <span class="history-link">{shortenUrl(vote.target.url)}</span>
                <span class="history-title">{`#${vote.id} · ${vote.target.site} · ${vote.attempts} attempts`}</span>
              </div>
              <span class="history-time">{waitLabel(vote, holdUntil, now)}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {votes.length > VISIBLE_ROWS ? <p class="row-hint">{`+${votes.length - VISIBLE_ROWS} more queued`}</p> : null}
    </section>
  );
};

export { QueueView };
