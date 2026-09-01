// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cross-tab vote propagation for mounted pickers.

import type { VoteBroadcast, VoteSyncMessage } from "../shared/messages";
import { ALL_SITE_MATCH_PATTERNS } from "../shared/sites";
import { queryTabs, sendMessageToTab } from "../shared/webext";
import { logBackgroundError } from "./debug";

export async function broadcastVoteDelta(senderTabId: number | undefined, delta: VoteBroadcast): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await queryTabs({ url: [...ALL_SITE_MATCH_PATTERNS] });
  } catch (error) {
    // No tab list means no cross-tab sync at all for this vote - the one failure
    // here worth naming, unlike the per-tab sends below.
    logBackgroundError("broadcastVoteDelta.queryTabs", error);
    return;
  }
  const msg: VoteSyncMessage = { type: "voteSync", ...delta };
  for (const tab of tabs) {
    if (tab.id === undefined || tab.id === senderTabId) continue;
    // Deliberately unlogged: a matching tab that has not injected the content
    // script (still loading, restored-but-discarded) rejects every send, so a
    // trace here would fire on ordinary browsing, once per tab per vote.
    void sendMessageToTab(tab.id, msg).catch(() => {});
  }
}
