// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { defined } from "./defined";

describe("defined", () => {
  it("omits undefined keys entirely, rather than setting them to undefined", () => {
    const out = defined({ a: 1, b: undefined, c: "x" });
    expect(Object.keys(out)).toEqual(["a", "c"]);
    expect("b" in out).toBe(false);
  });

  it("keeps null - it is a value, and on a vote it means un-react", () => {
    const out = defined({ reaction: null, lang: undefined });
    expect(out).toEqual({ reaction: null });
    expect("reaction" in out).toBe(true);
  });

  it("keeps the falsy values a truthiness guard would have dropped", () => {
    expect(defined({ n: 0, s: "", b: false })).toEqual({ n: 0, s: "", b: false });
  });

  it("copies rather than mutating the source", () => {
    const source = { a: 1, b: undefined };
    const out = defined(source);
    expect(out).not.toBe(source);
    expect("b" in source).toBe(true);
  });

  it("is shallow: a nested undefined is the nested object's business", () => {
    const out = defined({ outer: { inner: undefined } });
    expect(out).toEqual({ outer: { inner: undefined } });
  });
});
