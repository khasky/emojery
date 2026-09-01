// SPDX-License-Identifier: GPL-3.0-or-later
//
// The vote interaction owned by the content script: auth gate, optimistic cache update,
// cross-tab broadcast, and the vote message to the SW. Kept separate from the mount
// lifecycle so ownership of optimistic state (the content script computes `prevReaction`;
// the SW only enqueues it) stays obvious and testable.
import type { PickerInsertionPoint } from "../shared/adapter";
import { type RuntimeResponse, TITLE_MAX } from "../shared/messages";
import type { Reaction } from "../shared/reactions";
import { applyOptimisticReaction, type Settings } from "../shared/storage";
import { playReactionClickFloat, type ReactionAnimationOrigin } from "./animations";
import { sendMessage } from "./messaging";
import { dispatchVoteSync } from "./mount-registry";
import { autoPressNative, setFbPickPending } from "./native-trigger";
import { readContentSettings } from "./settings-cache";

type OnPick = (reaction: Reaction | null, origin?: ReactionAnimationOrigin) => Promise<boolean>;

// Build the picker's `onPick` for one mounted target. Returns `false` (vote
// dropped) only on the unauthed path, which opens the auth tab. A send the
// background refuses is rolled back asynchronously instead - see below.
export function createOnPick(ctx: { point: PickerInsertionPoint; settings: Settings }): OnPick {
  const { point, settings } = ctx;
  return async (reaction, origin) => {
    // Synchronous, ahead of every await: the picker has ALREADY asked to close by
    // now (Picker.handlePick closes before awaiting this), so the flyout teardown
    // must be told a pick is on its way or it dismisses what autoPressNative is
    // about to drive. Cleared by autoPressNative when the press settles.
    setFbPickPending(true);
    // Unauthed click -> open the auth tab and drop this vote entirely (no optimistic UI,
    // no cache write, no queue entry). Reads work without auth, so counts still render.
    const status = (await sendMessage({ type: "auth:status" }).catch(() => null)) as RuntimeResponse | null;
    if (status?.type !== "auth:status" || !status.authed || !status.userId) {
      setFbPickPending(false);
      void sendMessage({ type: "auth:openTab" }).catch(() => {});
      return false;
    }
    const userId = status.userId;
    const { prevReaction } = await applyOptimisticReaction(point.target, reaction, userId);
    // Mirror to the native control on the optimistic path (no-op unless the
    // auto-press setting is on; never blocks or fails the vote itself).
    autoPressNative(point, reaction, userId);
    void maybePlayClickReactionAnimation(reaction, origin, settings.reactionAnimations);
    // The SW fans this delta out to other tabs (see background/vote-sync.ts) once it
    // receives the `vote` below - no page-reachable channel is used.
    const lang = languageFallback();
    // Same bound the background's message guard enforces - over it, the whole
    // vote message is rejected rather than the title trimmed.
    const title = document.title.trim().slice(0, TITLE_MAX);
    // Not awaited: the picker paints its own optimistic state the moment this
    // resolves, and a message round-trip per click is visible. The failure path
    // below lands after that paint and undoes it.
    void sendMessage({
      type: "vote",
      target: point.target,
      reaction,
      prevReaction,
      ...(lang ? { lang } : {}),
      ...(title ? { title } : {}),
    })
      .catch(() => null)
      .then((response) => {
        if (response?.type === "ok") return;
        return rollbackOptimisticReaction(point, reaction, prevReaction, userId);
      });
    return true;
  };
}

// Undo a pick the background refused to queue. Storage is corrected first (it
// outlives this mount), then the picker on screen is walked back through the
// same channel a cross-tab vote uses - so the trigger stops showing a reaction
// that will never reach the server.
async function rollbackOptimisticReaction(point: PickerInsertionPoint, reaction: Reaction | null, prevReaction: Reaction | null, userId: string): Promise<void> {
  await applyOptimisticReaction(point.target, prevReaction, userId).catch(() => {});
  dispatchVoteSync({ target: point.target, reaction: prevReaction, prevReaction: reaction });
}

function languageFallback(): string | undefined {
  const pageLang = document.documentElement?.lang || document.body?.getAttribute("lang") || "";
  if (pageLang.trim()) return pageLang.trim();
  const browserLang = navigator.language.trim();
  if (browserLang) return browserLang;
  return undefined;
}

async function maybePlayClickReactionAnimation(reaction: Reaction | null, origin: ReactionAnimationOrigin | undefined, fallbackEnabled: boolean): Promise<void> {
  if (reaction === null) return;
  const current = await readContentSettings().catch(() => null);
  if ((current?.reactionAnimations ?? fallbackEnabled) === false) return;
  playReactionClickFloat(reaction, origin);
}
