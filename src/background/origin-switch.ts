// SPDX-License-Identifier: GPL-3.0-or-later
//
// A new log origin is taken from no API answer alone: only from a rewind record in the log's
// index.json that opens exactly that generation and carries the log key's signature. Without
// it the origin stays and the queue waits; otherwise the operator could announce a generation
// before rewinding, collect votes signed under it, and seal a chosen subset afterwards.

import { fromBase64, parseRewind, verifyNote } from "@emojery/shared/core";
import { LOG_BASE_URL, LOG_NAME, LOG_PUBKEY } from "../shared/deployment";
import { deadlineSignal } from "../shared/fetch-deadline";
import { logBackgroundError } from "./debug";

const INDEX_TIMEOUT_MS = 10_000;

/** True when index.json holds a rewind record, signed by the pinned log key, that opens `origin`. */
export async function originIsSigned(origin: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  if (!LOG_PUBKEY) return false;
  try {
    const signal = deadlineSignal(INDEX_TIMEOUT_MS);
    const res = await fetcher(`${LOG_BASE_URL}/index.json`, { cache: "no-store", ...(signal ? { signal } : {}) });
    if (!res.ok) return false;
    const index = (await res.json()) as { records?: { kind?: unknown; note?: unknown }[] };
    const key = fromBase64(LOG_PUBKEY);
    for (const r of index.records ?? []) {
      if (r.kind !== "rewind" || typeof r.note !== "string") continue;
      try {
        if (parseRewind(await verifyNote(r.note, LOG_NAME, key)).origin === origin) return true;
      } catch {
        // A record that does not verify opens nothing.
      }
    }
    return false;
  } catch (error) {
    logBackgroundError("originIsSigned", error);
    return false;
  }
}
