// SPDX-License-Identifier: GPL-3.0-or-later
//
// A group photo-post's action row labels its Comment and Send as ICON-ONLY
// buttons - aria «Залишити коментар» / «Надіслати», empty text, ~44px wide
// (captured live on the reported group permalinks, uk-UA UI). A row-marker rule
// that required visible text on the marker rejected that whole row, so the post
// scrolled by with no trigger while its text-labeled neighbours had one.
// The fix keeps icon-only markers valid in
// facebook-post-row.ts containsRowOrReplyMarker; comments abusing the same aria
// stay rejected structurally (isInNestedArticle + Reply-outranks-row).
//
// The group content itself sits behind a login, so this spec is deterministic
// the same way facebook-comment-injection.spec.ts is: it INJECTS the captured
// row shape - a Like whose text is the count, beside icon-only Comment/Send
// slots and a colon-aria reaction summary, keyed to its own synthetic photo
// permalink - into a live public post page. The fixed build must mount a
// trigger in that row (the pre-fix build rejects the row and never does).

import { expect, test } from "@playwright/test";
import { envUrl } from "./lib/extension";
import { requireFacebookPostMount } from "./lib/mount-wait";
import { gotoSettled } from "./lib/page-settle";
import { pollForValue } from "./lib/picker-probes";
import { DEEP_QUERY_ALL_SRC } from "./lib/probe-src";
import { sharedSession } from "./lib/shared-session";

const FACEBOOK_POST = envUrl("FACEBOOK_POST");
const MOUNT_TIMEOUT_MS = Number(process.env.E2E_FB_INJECT_MOUNT_TIMEOUT_MS ?? 30_000);
// The injected row must survive several scan/settle passes before we call its
// mount missing.
const INJECT_SETTLE_MS = Number(process.env.E2E_FB_INJECT_SETTLE_MS ?? 12_000);

// Synthetic media id for the injected unit's photo permalink, so its target
// key (facebook:photo:<id>) never collides with the host post's own key.
const INJECTED_FBID = "990000000000001";

const session = sharedSession();

test("an icon-only Comment/Send action row (group photo-post shape) still mounts a trigger", async () => {
  const page = await session().context.newPage();
  try {
    await gotoSettled(page, FACEBOOK_POST);

    // The post's own mount proves the adapter is live and locates its section.
    await requireFacebookPostMount(page, MOUNT_TIMEOUT_MS);

    // Rebuild the captured group photo-row beside the real post: its own story
    // unit (a photo permalink for identity), a Like slot (count as text + the
    // reactions chevron), icon-only Comment/Send slots (aria only, NO text,
    // narrow - the geometry fallback must not rescue them), and the colon-aria
    // reaction summary. The unit is a SIBLING of the post's section, so the
    // post's own one-Like container walks stay untouched.
    const injected = await page.evaluate<boolean>(`(() => {
      ${DEEP_QUERY_ALL_SRC}
      const anchor = deepQueryAll("[data-khasky-emojery-mounted]").find((el) => el.getBoundingClientRect().width > 0);
      if (!anchor) return false;
      const row = anchor.parentElement;
      const section = row && row.parentElement;
      const sectionParent = section && section.parentElement;
      if (!sectionParent) return false;
      const mk = (tag, attrs, text) => {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
        if (text) el.textContent = text;
        return el;
      };
      const unit = mk("div", { "data-e2e-injected-grouprow": "1" });
      const media = mk("a", { href: "/photo/?fbid=${INJECTED_FBID}", role: "link" }, "photo");
      unit.appendChild(media);
      const actions = mk("div", {});
      actions.style.cssText = "display:flex;align-items:center;gap:4px;";
      const slotLike = mk("div", {});
      const like = mk("div", { role: "button", "aria-label": "Подобається", tabindex: "0" }, "5");
      like.style.cssText = "display:inline-block;min-width:59px;min-height:16px;";
      const chevron = mk("div", { role: "button", "aria-label": "Відреагувати", tabindex: "0" });
      chevron.style.cssText = "display:inline-block;width:16px;height:16px;";
      slotLike.append(like, chevron);
      const slotComment = mk("div", {});
      const commentIcon = mk("div", { role: "button", "aria-label": "Залишити коментар", tabindex: "0" });
      commentIcon.style.cssText = "display:inline-block;width:44px;height:32px;";
      slotComment.appendChild(commentIcon);
      const slotSend = mk("div", {});
      const sendIcon = mk("div", { role: "button", "aria-label": "Надіслати", tabindex: "0" });
      sendIcon.style.cssText = "display:inline-block;width:44px;height:32px;";
      slotSend.appendChild(sendIcon);
      const summary = mk("div", { role: "button", "aria-label": "Подобається: 4 людини", tabindex: "0" });
      summary.style.cssText = "display:inline-block;width:18px;height:18px;";
      actions.append(slotLike, slotComment, slotSend, summary);
      unit.appendChild(actions);
      sectionParent.appendChild(unit);
      unit.scrollIntoView({ block: "center" });
      return true;
    })()`);
    expect(injected, "the synthetic group row must land beside the post's section").toBe(true);

    // The fixed build accepts the icon-only row and mounts a trigger keyed to
    // the injected photo id; the pre-fix text-required rule never does.
    // Polled: FB keys the mount only once its lazy post hydration lands, and no
    // event marks that moment.
    const readInjectedVerdict = () =>
      page
        .evaluate<{ hostInUnit: boolean; keyed: boolean }>(`(() => {
          ${DEEP_QUERY_ALL_SRC}
          const unit = document.querySelector('[data-e2e-injected-grouprow="1"]');
          if (!unit) return { hostInUnit: false, keyed: false };
          const hostInUnit = deepQueryAll(".khasky-emojery-host").some((h) => unit.contains(h) && h.getBoundingClientRect().width > 0);
          const keyed = deepQueryAll("[data-khasky-emojery-mounted]").some((a) => unit.contains(a) && (a.getAttribute("data-khasky-emojery-mounted") || "").includes("${INJECTED_FBID}"));
          return { hostInUnit, keyed };
        })()`)
        .catch(() => ({ hostInUnit: false, keyed: false }));
    const verdict = await pollForValue(readInjectedVerdict, (v) => v.keyed, INJECT_SETTLE_MS);
    expect(verdict.keyed, "the icon-only action row must mount an anchor keyed to its own photo id").toBe(true);
    expect(verdict.hostInUnit, "the icon-only action row must carry a visible trigger host").toBe(true);
  } finally {
    await page.close().catch(() => {});
  }
});
