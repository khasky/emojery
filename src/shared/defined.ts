// SPDX-License-Identifier: GPL-3.0-or-later
//
// `exactOptionalPropertyTypes` is on, so an optional field may be ABSENT or hold a
// value - never `undefined`. This replaces the `...(x ? { x } : {})` spread chains
// building such an object otherwise takes.
//
// Use this only where the guard IS a definedness check. A spread guarded on something
// else (a non-empty array, a count above zero) says something this cannot, and should
// stay a spread.

type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & { [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined> };

/**
 * Drop every key whose value is `undefined`, so the result satisfies a type whose
 * optional fields are exact. `null` is kept - it is a value, and on a vote it is the
 * one that means "un-react".
 */
export function defined<T extends object>(source: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) out[key] = value;
  }
  return out as Defined<T>;
}
