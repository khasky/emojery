// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { withExtensionUtm } from "./tracking-links";

describe("tracking links", () => {
  it("adds stable Emojery extension UTM parameters", () => {
    const url = new URL(
      withExtensionUtm("https://www.facebook.com/", {
        campaign: "popup_per_site_links",
        content: "facebook",
      }),
    );

    expect(url.origin).toBe("https://www.facebook.com");
    expect(url.pathname).toBe("/");
    expect(url.searchParams.get("utm_source")).toBe("emojery");
    expect(url.searchParams.get("utm_medium")).toBe("browser_extension");
    expect(url.searchParams.get("utm_campaign")).toBe("popup_per_site_links");
    expect(url.searchParams.get("utm_content")).toBe("facebook");
  });

  it("preserves existing query parameters", () => {
    const url = new URL(
      withExtensionUtm("https://example.com/?ref=existing", {
        campaign: "auth_consent_links",
        content: "privacy_policy",
      }),
    );

    expect(url.searchParams.get("ref")).toBe("existing");
    expect(url.searchParams.get("utm_source")).toBe("emojery");
    expect(url.searchParams.get("utm_campaign")).toBe("auth_consent_links");
    expect(url.searchParams.get("utm_content")).toBe("privacy_policy");
  });
});
