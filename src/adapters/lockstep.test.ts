// SPDX-License-Identifier: GPL-3.0-or-later
//
// Lockstep guard for the client's URL->target-key derivation. The id and its
// canonical URL are a permanent wire contract: a target's counts stay merged
// only while every URL variant of that item derives the SAME key - and both
// ends of the wire must derive that key from the same URLs. The vectors are
// data (`__data__/target-vectors.json`), not a table in this file, so each
// side pins its derivation against the same rows. This test replays every
// vector through the shipped parsers. Pure
// URL/string parsing; no supported-site DOM (an e2e concern per CONTRIBUTING.md).
import { describe, expect, it } from "vitest";
import { ALL_SITES } from "../shared/sites";
import vectors from "./__data__/target-vectors.json";
import { deriveTargetFromUrl, URL_DERIVABLE_SITES } from "./target-contract";

const DERIVABLE = vectors.urlDerivable as { site: string; url: string; targetId: string; variantUrls?: string[]; noTargetUrls?: string[] }[];
const NOT_URL_DERIVABLE = new Set(vectors.notUrlDerivable.map((row) => row.site));

describe("target-key lockstep (client URL->id derivation)", () => {
  // Coverage guard: adding a site to the registry forces an explicit choice in
  // the vector file - a urlDerivable row or a notUrlDerivable entry - so the
  // data can't silently fall out of date.
  it("covers every registered site", () => {
    for (const site of ALL_SITES) {
      const hasRow = DERIVABLE.some((row) => row.site === site);
      expect(hasRow || NOT_URL_DERIVABLE.has(site), `${site}: add a urlDerivable row to __data__/target-vectors.json (URL-derivable id) or list it under notUrlDerivable`).toBe(true);
      expect(hasRow && NOT_URL_DERIVABLE.has(site), `${site}: remove it from notUrlDerivable - it has a urlDerivable row`).toBe(false);
    }
  });

  it("the URL-derivable set and the registry agree", () => {
    expect([...URL_DERIVABLE_SITES].sort()).toEqual(ALL_SITES.filter((s) => !NOT_URL_DERIVABLE.has(s)).sort());
  });

  for (const s of DERIVABLE) {
    it(`${s.site}: URL derives to the canonical id and re-derives idempotently`, () => {
      const d = deriveTargetFromUrl(s.site, s.url);
      expect(d, `${s.site}: ${s.url} should derive a target`).not.toBeNull();
      if (!d) return;
      expect(d.targetId).toBe(s.targetId);
      // The canonical URL the client stores must re-derive to the SAME id - the
      // property the wire contract relies on to keep counts merged.
      expect(deriveTargetFromUrl(s.site, d.url)?.targetId, `${s.site}: canonical URL ${d.url} must re-derive to ${s.targetId}`).toBe(s.targetId);
    });

    // OTHER live surfaces of the SAME item (photo view, shorts, gallery, mobile
    // host, regional storefront) - each must converge on the row's id, which is
    // the "every URL variant derives the SAME key" half of the contract that a
    // single URL per site cannot pin.
    for (const variant of s.variantUrls ?? []) {
      it(`${s.site}: variant surface converges - ${variant}`, () => {
        expect(deriveTargetFromUrl(s.site, variant)?.targetId, `${s.site}: ${variant} must derive the same key as the canonical URL`).toBe(s.targetId);
      });
    }

    // The gates: a URL shape that looks derivable but is not the item (a profile,
    // a repo subpage, a reserved route), or an off-site host wearing the site's
    // path shape. Deriving a key from one of those would store a reaction under a
    // target that does not exist.
    for (const noTarget of s.noTargetUrls ?? []) {
      it(`${s.site}: derives nothing - ${noTarget}`, () => {
        expect(deriveTargetFromUrl(s.site, noTarget), `${s.site}: ${noTarget} must not derive a target`).toBeNull();
      });
    }
  }
});
