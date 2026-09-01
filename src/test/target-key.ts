// SPDX-License-Identifier: GPL-3.0-or-later
//
// `TargetKey` is branded (shared/storage.ts) so a bare string can't be used where a
// mount key belongs. Tests still want to write the key inline - `tk("instagram:abc")`
// is that, spelled once, instead of a cast at every call site.
//
// Production code must NOT use this: it builds keys with `targetKey(target)`, which is
// the only construction the brand is meant to allow.

import type { TargetKey } from "../shared/storage";

export function tk(key: string): TargetKey {
  return key as TargetKey;
}
