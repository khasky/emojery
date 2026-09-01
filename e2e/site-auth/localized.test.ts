// SPDX-License-Identifier: GPL-3.0-or-later
//
// Flow 4 - localized (RU/UA) logged-in labels. Opportunistic: Facebook's UI
// language follows the *account*, not the browser locale, so this only runs when
// the signed-in FB account renders RU/UA; otherwise it skips with a note. The
// durable stem-matching contract lives in the adapter unit tests
// (src/adapters/facebook.test.ts) - this only confirms it holds on the real,
// localized, logged-in DOM.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bridgeFixture, gotoSettled, readEvidence, SETUP_HOOK_TIMEOUT_MS, siteAuthEnabled, waitForHost } from "./harness";
import { authFeedUrl } from "./scenarios";

const fx = bridgeFixture();

(siteAuthEnabled() ? describe : describe.skip)("site-auth: localized (RU/UA)", () => {
  beforeAll(fx.setup, SETUP_HOOK_TIMEOUT_MS);
  afterAll(fx.teardown);

  test("facebook: RU/UA feed still mounts (stem matching) without overlap", async (ctx) => {
    const b = fx.need();
    await gotoSettled(b, authFeedUrl("facebook"), 4500);

    const lang = await b.evaluate<{ ru: boolean; cyrillic: boolean }>(`
      const l = (document.documentElement.getAttribute('lang') || '').toLowerCase();
      const ru = l.startsWith('ru') || l.startsWith('uk');
      const cyrillic = /нрав|подоба|вподоб/i.test(document.body.innerText || '');
      return { ru, cyrillic };
    `);
    if (!lang.ru && !lang.cyrillic) {
      ctx.skip(); // account UI is not RU/UA - covered by adapter unit tests instead
    }

    expect(await waitForHost(b, "facebook", 12_000), "facebook: no Emojery host on the RU/UA feed - log into Facebook in the connected Chrome.").toBeGreaterThan(0);
    const ev = await readEvidence(b, "facebook");
    // Stem matching surfaced the localized action row; ensure the trigger is a
    // real, non-degenerate box (overlap/clipping would collapse it).
    const ok = ev.hosts.some((h) => h.visible && h.width >= 16 && h.height >= 12);
    expect(ok, "a localized FB post should mount a properly-sized, non-overlapping trigger").toBe(true);
    expect(ev.duplicateKeys.length).toBe(0);
  });
});
