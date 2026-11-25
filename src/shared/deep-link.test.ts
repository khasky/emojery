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

  it("returns null for anything that isn't our hint", () => {
    expect(parseReactHint("")).toBeNull();
    expect(parseReactHint("#")).toBeNull();
    expect(parseReactHint("#readme")).toBeNull();
    expect(parseReactHint("#emojery-reaction")).toBeNull();
    expect(parseReactHint("#em-react")).toBeNull();
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
