// SPDX-License-Identifier: GPL-3.0-or-later
//
// Which accounts this device has signed in with, and what the reader calls them.
// Two device-local stores, both keyed by the account id the API returned:
//
//   - a name the reader typed, which replaces the derived label everywhere;
//   - the accounts seen on this device, so the sign-in page can say which account
//     the last sign-in through a provider used - the page runs before any account
//     is known, and a reader with two Google accounts needs that hint there most.
//
// Neither reaches the API or the public log: both are renderings of an id the
// browser already holds. Account deletion drops both (background/identity.ts).

import { accountLabel } from "./account-label";
import { providerLabel } from "./oidc-providers";
import { storageLocalGet, storageLocalRemove, storageLocalSet } from "./webext";

export const ACCOUNT_NAMES_KEY = "account_names_v1";
export const ACCOUNTS_SEEN_KEY = "accounts_seen_v1";

/** A name the reader typed, and the ceiling the derived label is built under.
 *  Long enough for "work" or "рабочий", short enough that the row shows it whole in
 *  a script whose characters are wide. Counted in characters, not bytes. */
export const ACCOUNT_NAME_MAX = 12;
// Enough to tell this device's accounts apart; past that the oldest goes, since a
// hint about an account last used a year ago helps nobody.
const SEEN_MAX = 12;

export interface SeenAccount {
  provider: string;
  userId: string;
  /** Ms-epoch of the last sign-in with it on this device. */
  at: number;
  /** Which account of this provider it was, in the order they were first used
   *  here - providerTag builds its tag from it ("Google #2"), and it is never part
   *  of the name the reader edits. Assigned once and kept,
   *  so renaming the first account does not make the next one take its number.
   *  Absent on a record written before this field existed; those keep the derived
   *  mark alone, since inventing a number now would misname an old account. */
  ordinal?: number;
}

type NameMap = Record<string, string>;

function asNameMap(value: unknown): NameMap {
  if (typeof value !== "object" || value === null) return {};
  const out: NameMap = {};
  for (const [id, name] of Object.entries(value as Record<string, unknown>)) {
    if (typeof name === "string" && name.trim() !== "") out[id] = name.slice(0, ACCOUNT_NAME_MAX);
  }
  return out;
}

function asSeen(value: unknown): SeenAccount[] {
  if (!Array.isArray(value)) return [];
  return value.filter((e): e is SeenAccount => typeof e === "object" && e !== null && typeof (e as SeenAccount).provider === "string" && typeof (e as SeenAccount).userId === "string" && typeof (e as SeenAccount).at === "number");
}

/** "Apple #1": the provider and which of its accounts on this device this one is.
 *  The number is never part of the name the reader edits - it identifies the account
 *  whatever they call it. Without a record to number it by, the provider stands alone. */
export function providerTag(provider: string, ordinal: number): string {
  const label = providerLabel(provider);
  return ordinal > 0 ? `${label} #${ordinal}` : label;
}

/** The name to show for an account: the reader's, or the derived label. */
export async function accountDisplayName(userId: string): Promise<string> {
  const stored = await storageLocalGet([ACCOUNT_NAMES_KEY]);
  return asNameMap(stored[ACCOUNT_NAMES_KEY])[userId] ?? accountLabel(userId);
}

/** Which account of its provider this one is here, or 0 when this device has no
 *  record to number it by - one pruned by SEEN_MAX, one written before ordinals
 *  existed, or an account known only from imported history. */
export async function accountOrdinal(userId: string): Promise<number> {
  const stored = await storageLocalGet([ACCOUNTS_SEEN_KEY]);
  return asSeen(stored[ACCOUNTS_SEEN_KEY]).find((e) => e.userId === userId)?.ordinal ?? 0;
}

/** Sets the reader's own name for an account; an empty one restores the label. */
export async function setAccountName(userId: string, name: string): Promise<void> {
  const stored = await storageLocalGet([ACCOUNT_NAMES_KEY]);
  const names = asNameMap(stored[ACCOUNT_NAMES_KEY]);
  const trimmed = name.trim().slice(0, ACCOUNT_NAME_MAX);
  if (trimmed === "") delete names[userId];
  else names[userId] = trimmed;
  if (Object.keys(names).length === 0) await storageLocalRemove([ACCOUNT_NAMES_KEY]);
  else await storageLocalSet({ [ACCOUNT_NAMES_KEY]: names });
}

/** Records a sign-in, so the sign-in page can name the account next time. */
export async function noteAccountSeen(provider: string, userId: string, now: number = Date.now()): Promise<void> {
  const stored = await storageLocalGet([ACCOUNTS_SEEN_KEY]);
  const all = asSeen(stored[ACCOUNTS_SEEN_KEY]);
  const rest = all.filter((e) => e.userId !== userId);
  // Kept across sign-ins, and never reused: the next account of this provider takes
  // one past the highest ever handed out here, so renaming or signing out of the
  // first does not hand its number to the second.
  const ordinal = all.find((e) => e.userId === userId)?.ordinal ?? highestOrdinal(all, provider) + 1;
  const seen = [{ provider, userId, at: now, ordinal }, ...rest].slice(0, SEEN_MAX);
  await storageLocalSet({ [ACCOUNTS_SEEN_KEY]: seen });
}

function highestOrdinal(seen: SeenAccount[], provider: string): number {
  return seen.reduce((high, e) => (e.provider === provider && typeof e.ordinal === "number" ? Math.max(high, e.ordinal) : high), 0);
}

/** The accounts this device has used, newest first. Exported for account-names.test.ts,
 *  which pins the ordering; inside this module only noteSeenAccount reads it. */
export async function readSeenAccounts(): Promise<SeenAccount[]> {
  const stored = await storageLocalGet([ACCOUNTS_SEEN_KEY]);
  return asSeen(stored[ACCOUNTS_SEEN_KEY]).sort((a, b) => b.at - a.at);
}

/** The most recent account used with each provider: which account of that provider
 *  it was, what it is called, and when it was last used here - the three things that
 *  tell two accounts of one provider apart before either has been renamed. */
export async function lastAccountPerProvider(): Promise<Record<string, { name: string; ordinal: number; at: number }>> {
  const [seen, stored] = await Promise.all([readSeenAccounts(), storageLocalGet([ACCOUNT_NAMES_KEY])]);
  const names = asNameMap(stored[ACCOUNT_NAMES_KEY]);
  const out: Record<string, { name: string; ordinal: number; at: number }> = {};
  for (const entry of seen) {
    if (out[entry.provider] === undefined) out[entry.provider] = { name: names[entry.userId] ?? accountLabel(entry.userId), ordinal: entry.ordinal ?? 0, at: entry.at };
  }
  return out;
}

/** Drops everything this device remembered about one account (account deletion). */
export async function forgetAccount(userId: string): Promise<void> {
  const stored = await storageLocalGet([ACCOUNT_NAMES_KEY, ACCOUNTS_SEEN_KEY]);
  const names = asNameMap(stored[ACCOUNT_NAMES_KEY]);
  delete names[userId];
  const seen = asSeen(stored[ACCOUNTS_SEEN_KEY]).filter((e) => e.userId !== userId);
  const writes: Record<string, unknown> = {};
  const drops: string[] = [];
  if (Object.keys(names).length === 0) drops.push(ACCOUNT_NAMES_KEY);
  else writes[ACCOUNT_NAMES_KEY] = names;
  if (seen.length === 0) drops.push(ACCOUNTS_SEEN_KEY);
  else writes[ACCOUNTS_SEEN_KEY] = seen;
  if (Object.keys(writes).length > 0) await storageLocalSet(writes);
  if (drops.length > 0) await storageLocalRemove(drops);
}
