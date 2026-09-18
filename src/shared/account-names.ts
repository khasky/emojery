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
import { storageLocalGet, storageLocalRemove, storageLocalSet } from "./webext";

export const ACCOUNT_NAMES_KEY = "account_names_v1";
export const ACCOUNTS_SEEN_KEY = "accounts_seen_v1";

/** A name the reader typed. Long enough for "work" or "личный аккаунт", short
 *  enough to sit in the popup's one-line row. */
export const ACCOUNT_NAME_MAX = 32;
// Enough to tell this device's accounts apart; past that the oldest goes, since a
// hint about an account last used a year ago helps nobody.
const SEEN_MAX = 12;

export interface SeenAccount {
  provider: string;
  userId: string;
  /** Ms-epoch of the last sign-in with it on this device. */
  at: number;
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

/** The name to show for an account: the reader's, or the derived label. */
export async function accountDisplayName(userId: string): Promise<string> {
  const stored = await storageLocalGet([ACCOUNT_NAMES_KEY]);
  return asNameMap(stored[ACCOUNT_NAMES_KEY])[userId] ?? accountLabel(userId);
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
  const rest = asSeen(stored[ACCOUNTS_SEEN_KEY]).filter((e) => e.userId !== userId);
  const seen = [{ provider, userId, at: now }, ...rest].slice(0, SEEN_MAX);
  await storageLocalSet({ [ACCOUNTS_SEEN_KEY]: seen });
}

/** The accounts this device has used, newest first. */
export async function readSeenAccounts(): Promise<SeenAccount[]> {
  const stored = await storageLocalGet([ACCOUNTS_SEEN_KEY]);
  return asSeen(stored[ACCOUNTS_SEEN_KEY]).sort((a, b) => b.at - a.at);
}

/** The most recent account used with each provider, with its display name. */
export async function lastAccountPerProvider(): Promise<Record<string, string>> {
  const [seen, stored] = await Promise.all([readSeenAccounts(), storageLocalGet([ACCOUNT_NAMES_KEY])]);
  const names = asNameMap(stored[ACCOUNT_NAMES_KEY]);
  const out: Record<string, string> = {};
  for (const entry of seen) {
    if (out[entry.provider] === undefined) out[entry.provider] = names[entry.userId] ?? accountLabel(entry.userId);
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
