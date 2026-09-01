// SPDX-License-Identifier: GPL-3.0-or-later

import { API_BASE } from "../shared/config";
import { resolveLocalAnalyticsConsent } from "../shared/data-consent";
import { apiFetch, logBackgroundError } from "./debug";
import { authRequestLanguage, getAuth, jsonApiHeaders } from "./identity";

/** Submit one problem report. Resolves `false` when nothing reached the server, so the
 *  popup can say the note was not sent instead of showing a success screen for it. */
export async function reportProblem(payload: { site: string; host: string; url: string; targetCount: number; note?: string }): Promise<boolean> {
  const analyticsConsent = await resolveLocalAnalyticsConsent();
  try {
    const auth = await getAuth();
    if (!auth) return false;
    const lang = authRequestLanguage();
    const res = await apiFetch(`${API_BASE}/report`, {
      method: "POST",
      headers: await jsonApiHeaders({ token: auth.token, ...(lang ? { lang } : {}) }),
      body: JSON.stringify({
        event: "report",
        ...payload,
        ...(analyticsConsent
          ? {
              ua: navigator.userAgent,
              version: chrome.runtime.getManifest().version,
            }
          : {}),
      }),
      keepalive: true,
    });
    return res.ok;
  } catch (error) {
    logBackgroundError("reportProblem", error);
    return false;
  }
}
