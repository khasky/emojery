// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { BEACON_DATASET_KEY, buildReactHint, parseReactHint } from "./deep-link";

describe("parseReactHint", () => {
  it("treats a bare #emojery-react as keyless (open the first target)", () => {
    expect(parseReactHint("#emojery-react")).toEqual({ targetKey: null });
    expect(parseReactHint("emojery-react")).toEqual({ targetKey: null });
  });

  it("decodes the percent-encoded target key", () => {
    expect(parseReactHint(`#emojery-react=${encodeURIComponent("github:owner/repo")}`)).toEqual({ targetKey: "github:owner/repo" });
    expect(parseReactHint(`#emojery-react=${encodeURIComponent("instagram:p:Cabc")}`)).toEqual({ targetKey: "instagram:p:Cabc" });
  });

  it("treats an empty keyed value as keyless", () => {
    expect(parseReactHint("#emojery-react=")).toEqual({ targetKey: null });
  });

  // The two sides of this contract deploy separately: an updated extension can
  // meet an emojery.app that still emits the short name, and that must still
  // open the picker rather than land the user on a page that ignores them.
  it("still reads the short `em-react` name the /react page used to emit", () => {
    expect(parseReactHint("#em-react")).toEqual({ targetKey: null });
    expect(parseReactHint(`#em-react=${encodeURIComponent("github:owner/repo")}`)).toEqual({ targetKey: "github:owner/repo" });
  });

  it("returns null for anything that isn't our hint", () => {
    expect(parseReactHint("")).toBeNull();
    expect(parseReactHint("#")).toBeNull();
    expect(parseReactHint("#readme")).toBeNull();
    expect(parseReactHint("#emojery-reaction")).toBeNull();
    // The pre-rename hash the /react page emitted before the website switched
    // to `em-react` - deliberately no longer recognised.
    expect(parseReactHint("#wr-react")).toBeNull();
  });

  it("emits only the current name", () => {
    expect(buildReactHint("x:123")).toBe(`#emojery-react=${encodeURIComponent("x:123")}`);
    expect(buildReactHint(null)).toBe("#emojery-react");
  });
});

describe("BEACON_DATASET_KEY", () => {
  it("maps to the data-emojery attribute the page reads", () => {
    expect(BEACON_DATASET_KEY).toBe("emojery");
  });
});
