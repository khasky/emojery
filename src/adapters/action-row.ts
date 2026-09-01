// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared comment-row rejection: a comment row carries a Reply control and NONE of
// the post markers (Comment/Share/Send/Repost), so the picker never mounts on a
// comment. Recognition is POSITIVE - an unreadable locale (no recognizable Reply)
// returns false, keeping a geometry-detected post bar in a language we can't read.
// Deliberately no shared findActionRow here: each adapter keeps its bespoke row
// walk (see docs/adding-a-site.md).
import type { ActionKind, LabelRegistry } from "./action-labels";

export function rejectCommentRow(postMarkers: readonly ActionKind[], replyKind: ActionKind): (row: HTMLElement, registry: LabelRegistry) => boolean {
  return (row, registry) => {
    const present = registry.presentKinds(row);
    if (postMarkers.some((m) => present.has(m))) return false;
    return present.has(replyKind);
  };
}
