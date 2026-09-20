// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import opencriticAdapter, { extractOpenCriticGameRef, opencriticTargetFromRef } from "./opencritic";
import { expectMatchesRegistryHosts } from "./test-fixtures";

describe("opencritic adapter", () => {
  it("matches its registry hosts only", () => {
    expectMatchesRegistryHosts(opencriticAdapter, "opencritic");
    // `www.opencritic.com` 301s to the apex and is not a run host.
    expect(opencriticAdapter.matches("www.opencritic.com")).toBe(false);
    expect(opencriticAdapter.matches("opencritic.com.evil.example")).toBe(false);
  });
});

describe("extractOpenCriticGameRef", () => {
  it("reads the game id and the slug the page carried", () => {
    expect(extractOpenCriticGameRef("https://opencritic.com/game/12090/elden-ring")).toEqual({ gameId: "12090", slug: "elden-ring" });
    expect(extractOpenCriticGameRef("https://opencritic.com/game/12090/elden-ring/")).toEqual({ gameId: "12090", slug: "elden-ring" });
    expect(extractOpenCriticGameRef("https://opencritic.com/game/12090/elden-ring?utm_source=x")).toEqual({ gameId: "12090", slug: "elden-ring" });
  });

  it("keys on the id alone, whatever slug the link carried", () => {
    // OpenCritic ignores the slug: any value serves the game.
    const canonical = opencriticTargetFromRef(extractOpenCriticGameRef("https://opencritic.com/game/12090/elden-ring")!);
    for (const href of ["https://opencritic.com/game/12090/a-completely-wrong-slug", "https://opencritic.com/game/12090/Elden-Ring", "https://opencritic.com/game/12090/g"]) {
      expect(opencriticTargetFromRef(extractOpenCriticGameRef(href)!).targetId).toBe(canonical.targetId);
    }
  });

  it("reads nothing off a slugless path, a subpage, another entity or another host", () => {
    // The slug segment is required - a bare `/game/<id>` is a 404, not the game.
    expect(extractOpenCriticGameRef("https://opencritic.com/game/12090")).toBeNull();
    expect(extractOpenCriticGameRef("https://opencritic.com/game/12090/")).toBeNull();
    expect(extractOpenCriticGameRef("https://opencritic.com/game/12090/elden-ring/reviews")).toBeNull();
    expect(extractOpenCriticGameRef("https://opencritic.com/outlet/56/ign")).toBeNull();
    expect(extractOpenCriticGameRef("https://opencritic.com/browse/all")).toBeNull();
    expect(extractOpenCriticGameRef("https://opencritic.com/game/not-a-number/elden-ring")).toBeNull();
    expect(extractOpenCriticGameRef("https://opencritic.com/")).toBeNull();
    expect(extractOpenCriticGameRef("https://evil.example/game/12090/elden-ring")).toBeNull();
    expect(extractOpenCriticGameRef(null)).toBeNull();
  });
});

describe("opencriticTargetFromRef", () => {
  it("builds a canonical URL that re-derives its own id", () => {
    const target = opencriticTargetFromRef({ gameId: "12090", slug: "elden-ring" });
    expect(target).toEqual({ site: "opencritic", targetId: "12090", url: "https://opencritic.com/game/12090/elden-ring" });
    expect(extractOpenCriticGameRef(target.url)).toEqual({ gameId: "12090", slug: "elden-ring" });
  });
});
