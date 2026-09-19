// SPDX-License-Identifier: GPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";
import { noteTermsAccepted, TERMS_ACCEPTED_KEY, TERMS_REVISION, termsAccepted } from "./terms-consent";

let store: Record<string, unknown> = {};
let throwOnGet = false;

beforeEach(() => {
  store = {};
  throwOnGet = false;
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: (keys: string[], done: (items: Record<string, unknown>) => void) => {
          if (throwOnGet) throw new Error("storage unavailable");
          done(Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])));
        },
        set: (items: Record<string, unknown>, done: () => void) => {
          Object.assign(store, items);
          done();
        },
        remove: (keys: string[], done: () => void) => {
          for (const k of keys) delete store[k];
          done();
        },
      },
    },
  });
});

describe("the terms agreement", () => {
  it("is not given until it is", async () => {
    expect(await termsAccepted()).toBe(false);
  });

  it("is remembered with the revision it was given for", async () => {
    await noteTermsAccepted(true);
    expect(await termsAccepted()).toBe(true);
    expect(store[TERMS_ACCEPTED_KEY]).toMatchObject({ revision: TERMS_REVISION });
    expect((store[TERMS_ACCEPTED_KEY] as { at: number }).at).toBeGreaterThan(0);
  });

  // The whole point of storing the revision: an agreement given for older text is
  // not an agreement to the text now in force.
  it("is not carried forward to a newer revision", async () => {
    store[TERMS_ACCEPTED_KEY] = { revision: "1970-01-01", at: Date.now() };
    expect(await termsAccepted()).toBe(false);
  });

  it("is forgotten when the reader clears the box", async () => {
    await noteTermsAccepted(true);
    await noteTermsAccepted(false);
    expect(TERMS_ACCEPTED_KEY in store).toBe(false);
    expect(await termsAccepted()).toBe(false);
  });

  it.each([null, "yes", 42, {}, { revision: TERMS_REVISION }, { at: Date.now() }, { revision: 1, at: 1 }])("reads a malformed record as no agreement (%p)", async (value) => {
    store[TERMS_ACCEPTED_KEY] = value;
    expect(await termsAccepted()).toBe(false);
  });

  // Asking again costs a click; assuming an agreement nobody gave costs the thing
  // the checkbox is there for.
  it("reads as no agreement when storage cannot be read at all", async () => {
    await noteTermsAccepted(true);
    throwOnGet = true;
    expect(await termsAccepted()).toBe(false);
  });
});
