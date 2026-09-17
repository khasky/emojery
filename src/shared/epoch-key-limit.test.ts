// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome } from "../test/fixtures";
import { EPOCH_KEY_LIMIT_KEY, noteEpochKeyLimit, readEpochKeyLimitNotice } from "./epoch-key-limit";

const EPOCH_MS = 1_000;

let local: Record<string, unknown>;

beforeEach(() => {
  local = installFakeChrome().local;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("epoch key limit notice", () => {
  it("names the epoch and the start of the next one", async () => {
    await noteEpochKeyLimit(41, EPOCH_MS);
    expect(local[EPOCH_KEY_LIMIT_KEY]).toEqual({ epoch: 41, resumesAt: 42_000 });
    expect(await readEpochKeyLimitNotice(41_999)).toEqual({ epoch: 41, resumesAt: 42_000 });
  });

  it("is gone once the next epoch has started, and the stored copy with it", async () => {
    await noteEpochKeyLimit(41, EPOCH_MS);
    expect(await readEpochKeyLimitNotice(42_000)).toBeNull();
    expect(local[EPOCH_KEY_LIMIT_KEY]).toBeUndefined();
  });

  it("drops a stored value that is not a notice", async () => {
    local[EPOCH_KEY_LIMIT_KEY] = { resumesAt: "soon" };
    expect(await readEpochKeyLimitNotice(0)).toBeNull();
    expect(local[EPOCH_KEY_LIMIT_KEY]).toBeUndefined();
  });

  it("reads nothing, and removes nothing, when no notice was written", async () => {
    expect(await readEpochKeyLimitNotice()).toBeNull();
    expect(chrome.storage.local.remove).not.toHaveBeenCalled();
  });
});
