// SPDX-License-Identifier: GPL-3.0-or-later
//
// Whether this device has given both agreements the sign-in page asks for - the
// Terms of Use (with the age line) and the publication of every reaction in the
// public log - so the page stops asking on every sign-in. One record for the two:
// a sign-in needs both, so it is written only once both are ticked and dropped as
// soon as either is cleared. Device-local, and NOT account-scoped: the reader
// agreed, not the account, so it outlives a sign-out and an account deletion
// (background/identity.ts clears only account state).
//
// Stored with the revision of the documents it was given for. The terms and the
// privacy policy carry a "Last updated" line, and TERMS_REVISION is the later of
// the two - raise it when either changes materially, or the wording of either
// agreement does, and every device is asked again instead of carrying an
// agreement forward to text nobody has read.

import { storageLocalGet, storageLocalRemove, storageLocalSet } from "./webext";

export const TERMS_ACCEPTED_KEY = "terms_accepted_v1";

/** emojery.app/terms and /privacy, the later "Last updated" of the two. */
export const TERMS_REVISION = "2026-11-24";

interface TermsAcceptance {
  revision: string;
  /** Ms-epoch of the tick, so a record can be read back as "when", not just "yes". */
  at: number;
}

function asAcceptance(value: unknown): TermsAcceptance | null {
  if (typeof value !== "object" || value === null) return null;
  const { revision, at } = value as Partial<TermsAcceptance>;
  if (typeof revision !== "string" || typeof at !== "number" || !Number.isFinite(at)) return null;
  return { revision, at };
}

/** True only for an agreement given for the revision now in force. A storage read
 *  that throws answers false: asking again costs a click, assuming agreement that
 *  was never given costs the thing the checkbox is there for. */
export async function termsAccepted(): Promise<boolean> {
  try {
    const stored = await storageLocalGet([TERMS_ACCEPTED_KEY]);
    return asAcceptance(stored[TERMS_ACCEPTED_KEY])?.revision === TERMS_REVISION;
  } catch {
    return false;
  }
}

/** Remember both ticks, or forget them when the reader clears either box. */
export async function noteTermsAccepted(accepted: boolean): Promise<void> {
  if (!accepted) {
    await storageLocalRemove([TERMS_ACCEPTED_KEY]);
    return;
  }
  await storageLocalSet({ [TERMS_ACCEPTED_KEY]: { revision: TERMS_REVISION, at: Date.now() } satisfies TermsAcceptance });
}
