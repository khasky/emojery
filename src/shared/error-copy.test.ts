// SPDX-License-Identifier: GPL-3.0-or-later

import { describe, expect, it } from "vitest";
import enMessages from "./__generated__/messages-en.json";
import { errorCopyKey } from "./error-copy";
import type { RuntimeErrorCode } from "./messages";

// The union as the guard enumerates it. Kept literal so a new code added to
// shared/messages.ts fails HERE (missing from the exhaustive check below) rather than
// silently rendering the caller's fallback forever.
const ALL_CODES: RuntimeErrorCode[] = ["network", "rate_limited", "server", "unavailable"];

describe("errorCopyKey", () => {
  it("gives the two user-actionable codes their own copy", () => {
    expect(errorCopyKey("network", "loadError")).toBe("errOffline");
    expect(errorCopyKey("rate_limited", "loadError")).toBe("errRateLimited");
  });

  it("distinguishes a server fault from the generic failure", () => {
    expect(errorCopyKey("server", "loadError")).toBe("errServerBusy");
  });

  it("falls through to the caller's own wording for the generic code", () => {
    // `unavailable` is the catch-all, so the Report tab keeps saying "could not send the
    // report" instead of a second, vaguer way of saying the same thing.
    expect(errorCopyKey("unavailable", "reportSendError")).toBe("reportSendError");
    expect(errorCopyKey("unavailable", "loadError")).toBe("loadError");
  });

  it("falls through when there is no code at all (a rejected message, not an error response)", () => {
    expect(errorCopyKey(undefined, "loadError")).toBe("loadError");
    expect(errorCopyKey(null, "reportSendError")).toBe("reportSendError");
  });

  it("resolves every code to a key that exists in the catalog", () => {
    for (const code of ALL_CODES) {
      const key = errorCopyKey(code, "loadError");
      expect(enMessages, `${code} maps to '${key}', which is not an en message`).toHaveProperty(key);
    }
  });
});
