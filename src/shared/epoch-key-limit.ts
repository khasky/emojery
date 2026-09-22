// SPDX-License-Identifier: GPL-3.0-or-later
//
// The notice the drain leaves when the API refuses this device's votes until a
// stated date: they are refused before they are sent, so nothing reaches the wire
// and the reader needs telling. Written by background/api.ts, read by the popup's
// Account tab, and dropped by whoever reads it first once that date has passed.

import { storageLocalGet, storageLocalRemove, storageLocalSet } from "./webext";

export const EPOCH_KEY_LIMIT_KEY = "epoch_key_limit_v1";

export interface EpochKeyLimitNotice {
  epoch: number;
  /** Ms-epoch start of the next key epoch, when voting resumes. */
  resumesAt: number;
}

export async function noteEpochKeyLimit(epoch: number, epochMs: number): Promise<void> {
  await storageLocalSet({ [EPOCH_KEY_LIMIT_KEY]: { epoch, resumesAt: (epoch + 1) * epochMs } satisfies EpochKeyLimitNotice });
}

/** The live notice, or null. A notice whose epoch has passed, or one that is not
 *  the shape written above, is removed on the way out. */
export async function readEpochKeyLimitNotice(now: number = Date.now()): Promise<EpochKeyLimitNotice | null> {
  const stored = await storageLocalGet([EPOCH_KEY_LIMIT_KEY]);
  const notice = stored[EPOCH_KEY_LIMIT_KEY] as Partial<EpochKeyLimitNotice> | undefined;
  if (notice === undefined) return null;
  if (typeof notice?.epoch === "number" && typeof notice.resumesAt === "number" && notice.resumesAt > now) return { epoch: notice.epoch, resumesAt: notice.resumesAt };
  await storageLocalRemove([EPOCH_KEY_LIMIT_KEY]);
  return null;
}
