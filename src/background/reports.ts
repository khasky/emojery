// SPDX-License-Identifier: GPL-3.0-or-later

import { resolveLocalAnalyticsConsent } from "../shared/data-consent";
import { apiRequest, requestLanguage } from "./api-client";
import { logBackgroundError } from "./debug";
import { getAuth } from "./identity";

/** Submit one problem report. Resolves `false` when nothing reached the server, so the
 *  popup can say the note was not sent instead of showing a success screen for it. */
export async function reportProblem(payload: { site: string; host: string; url: string; targetCount: number; note?: string }): Promise<boolean> {
  const analyticsConsent = await resolveLocalAnalyticsConsent();
  try {
    const auth = await getAuth();
    if (!auth) return false;
    const reply = await apiRequest("/report", {
      method: "POST",
      token: auth.token,
      lang: requestLanguage(),
      body: {
        event: "report",
        ...payload,
        ...(analyticsConsent
          ? {
              ua: navigator.userAgent,
              version: chrome.runtime.getManifest().version,
            }
          : {}),
      },
      keepalive: true,
    });
    return reply.ok;
  } catch (error) {
    logBackgroundError("reportProblem", error);
    return false;
  }
}
