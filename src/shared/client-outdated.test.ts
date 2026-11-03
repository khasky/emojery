// SPDX-License-Identifier: GPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome } from "../test/fixtures";
import { CLIENT_OUTDATED_KEY, markClientOutdated, readClientOutdated, storeUrl } from "./client-outdated";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client-outdated flag", () => {
  it("is off until the background marks it, then on for this build", async () => {
    const fake = installFakeChrome({ manifest: { version: "1.1.0" } });
    expect(await readClientOutdated()).toBe(false);
    await markClientOutdated();
    expect(fake.local[CLIENT_OUTDATED_KEY]).toBe("1.1.0");
    expect(await readClientOutdated()).toBe(true);
  });

  it("no longer applies once the extension updates to another version", async () => {
    installFakeChrome({ manifest: { version: "1.1.1" }, local: { [CLIENT_OUTDATED_KEY]: "1.1.0" } });
    expect(await readClientOutdated()).toBe(false);
  });
});

describe("storeUrl", () => {
  it("picks the store this browser updates from", () => {
    expect(storeUrl("Mozilla/5.0 (Windows NT 10.0; rv:131.0) Gecko/20100101 Firefox/131.0")).toContain("addons.mozilla.org");
    expect(storeUrl("Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toContain("microsoftedge.microsoft.com");
    expect(storeUrl("Mozilla/5.0 AppleWebKit/537.36 Chrome/130.0.0.0 Safari/537.36")).toContain("chromewebstore.google.com");
  });
});
