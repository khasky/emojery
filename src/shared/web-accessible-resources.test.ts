// SPDX-License-Identifier: GPL-3.0-or-later
//
// The gate described in docs/permissions.md: on the Firefox MV2 build the manifest's
// resource list carries no per-origin `matches`, so every entry is readable by any page
// that learns the extension's origin. This pins the list to the three known-public asset
// groups, so a fourth entry has to be argued for in review instead of riding in on a
// pattern edit.

import { describe, expect, it } from "vitest";
import { WEB_ACCESSIBLE_RESOURCES } from "./web-accessible-resources";

// Each entry, with why its contents are safe for any page to read.
const REVIEWED: Record<string, string> = {
  "icons/*": "the toolbar and store icons - public art",
  "emoji-data/*.json": "CLDR emoji labels, pruned from emojibase-data at build time",
  "emoji-sprite/*": "the Noto Emoji sheet (SIL OFL 1.1) the picker renders from",
};

describe("web-accessible resources", () => {
  it("lists only groups whose disclosure has been reviewed", () => {
    for (const pattern of WEB_ACCESSIBLE_RESOURCES) {
      expect(REVIEWED[pattern], `${pattern} is web-accessible but has no reviewed reason. On the Firefox MV2 build the per-origin gate does not exist, so any page that learns the extension's origin can read it. Add the entry to REVIEWED with the reason it is safe, or do not expose it.`).toBeDefined();
    }
  });

  it("keeps every reviewed group actually listed, so a stale reason cannot linger", () => {
    expect([...WEB_ACCESSIBLE_RESOURCES].sort()).toEqual(Object.keys(REVIEWED).sort());
  });

  it("exposes no bare wildcard and nothing outside the packaged asset folders", () => {
    for (const pattern of WEB_ACCESSIBLE_RESOURCES) {
      expect(pattern, "a bare wildcard would expose the whole package, source maps included").not.toBe("*");
      expect(pattern, "resources are packaged assets, never a path escaping the extension root").not.toMatch(/^\/|\.\./);
      expect(pattern, "every entry names a folder, so a top-level file can never be added by accident").toMatch(/^[a-z-]+\//);
    }
  });
});
