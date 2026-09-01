// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it } from "vitest";
import { tk } from "../test/target-key";
import { __resetReactHintForTest, armReactHint, consumeReactHint } from "./deep-link";

beforeEach(() => {
  __resetReactHintForTest();
  history.replaceState(null, "", "/some/path");
});

describe("armReactHint / consumeReactHint", () => {
  it("arms a keyed hint, strips the hash, and consumes it once for the matching key", () => {
    window.location.hash = `#emojery-react=${encodeURIComponent("github:owner/repo")}`;
    armReactHint();
    expect(location.hash).toBe("");

    expect(consumeReactHint(tk("gitlab:other/thing"))).toBe(false);
    expect(consumeReactHint(tk("github:owner/repo"))).toBe(true);
    expect(consumeReactHint(tk("github:owner/repo"))).toBe(false);
  });

  it("consumes a keyless hint for the first target that asks", () => {
    window.location.hash = "#emojery-react";
    armReactHint();
    expect(consumeReactHint(tk("youtube:abc"))).toBe(true);
    expect(consumeReactHint(tk("youtube:def"))).toBe(false);
  });

  it("does nothing when the hash isn't our hint", () => {
    window.location.hash = "#readme";
    armReactHint();
    expect(consumeReactHint(tk("github:owner/repo"))).toBe(false);
  });
});
