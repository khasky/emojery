// SPDX-License-Identifier: GPL-3.0-or-later
import { type ComponentChild, Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { removeTechnicalAndInteractionConsent, requestTechnicalAndInteractionConsent } from "../../shared/data-consent";
import { t } from "../../shared/i18n";
import type { Settings } from "../../shared/storage";
import { sendRuntimeMessage } from "../../shared/webext";
import { HistoryDataSection } from "./popup-history-data";
import { IconRow, SignInPrompt } from "./popup-shared";
import { SlideToConfirm } from "./popup-slide-confirm";

const ICON_USER: ComponentChild[] = [<circle cx="12" cy="8" r="3.4" />, <path d="M5.5 19.2a6.6 6.6 0 0 1 13 0" />];
const ICON_CHART: ComponentChild[] = [<path d="M5 20.5V11M12 20.5V4M19 20.5v-6.5" />, <path d="M3.5 20.5h17" />];
const ICON_TRASH: ComponentChild[] = [<path d="M4 7h16M9 7V5.2a1.2 1.2 0 0 1 1.2-1.2h3.6A1.2 1.2 0 0 1 15 5.2V7m2.5 0v11.5a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2V7" />, <path d="M10 11v5.5M14 11v5.5" />];

const AnalyticsConsentSection = ({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => Promise<void> }) => {
  const updateAnalyticsConsent = async (enabled: boolean) => {
    if (!enabled) {
      await removeTechnicalAndInteractionConsent();
      await update({ analyticsConsent: false });
      return;
    }

    const granted = await requestTechnicalAndInteractionConsent();
    await update({ analyticsConsent: granted });
  };

  return (
    <IconRow tag="label" rowClass="row arow" icon={ICON_CHART} label={t("settingAnalyticsConsent")} hint={t("settingAnalyticsConsentHint")}>
      <input class="toggle" type="checkbox" checked={settings.analyticsConsent} onChange={(e: Event) => void updateAnalyticsConsent((e.currentTarget as HTMLInputElement).checked)} />
    </IconRow>
  );
};

// `refresh` re-reads auth status, flipping the view to signed-out after a delete.
const DeleteAccountRow = ({ refresh }: { refresh: () => void }) => {
  const [armed, setArmed] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const armButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasArmed = useRef(false);

  // Cancelling unmounts the slide control that held focus, so it would fall to <body>; hand it
  // back to the button that armed the confirm (WCAG 2.4.3). Nothing armed the first render.
  useEffect(() => {
    if (!armed && wasArmed.current) armButtonRef.current?.focus();
    wasArmed.current = armed;
  }, [armed]);

  return (
    <Fragment>
      <IconRow rowClass="row arow" icon={ICON_TRASH} danger label={t("deleteAccountLabel")} hint={t("deleteAccountHint")}>
        {armed ? null : (
          <button ref={armButtonRef} class="linkish danger" type="button" onClick={() => setArmed(true)}>
            {t("deleteAccountBtn")}
          </button>
        )}
      </IconRow>
      {armed ? (
        <div class="delete-confirm">
          {deleting ? (
            <p class="delete-confirm-progress">{t("deleteAccountProgress")}</p>
          ) : (
            <Fragment>
              <p class="delete-confirm-warn">{t("deleteAccountConfirm")}</p>
              <div class="delete-confirm-actions">
                <SlideToConfirm
                  label={t("deleteAccountSlide")}
                  autoFocus
                  onConfirm={() => {
                    setDeleting(true);
                    void sendRuntimeMessage({ type: "auth:delete" })
                      .then((resp) => {
                        if (resp?.type !== "ok") setDeleting(false);
                      })
                      .catch(() => setDeleting(false))
                      .finally(refresh);
                  }}
                />
                <button class="delete-cancel" type="button" disabled={deleting} onClick={() => setArmed(false)}>
                  {t("cancelBtn")}
                </button>
              </div>
            </Fragment>
          )}
        </div>
      ) : null}
    </Fragment>
  );
};

const AccountView = ({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => Promise<void> }) => {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null>(null);

  const refresh = () => {
    void sendRuntimeMessage({ type: "auth:status" })
      .then((resp) => {
        if (resp?.type === "auth:status") {
          setAuthed(resp.authed);
          setUserId(resp.userId);
          setEmail(resp.email);
        } else {
          setAuthed(false);
        }
      })
      .catch(() => setAuthed(false));
  };

  useEffect(refresh, []);

  if (authed === null) return null;

  if (!authed) {
    // Analytics consent stays hidden until sign-in: the toggle governs data
    // tied to the signed-in identity, so showing it here was misleading.
    return <SignInPrompt message={t("signInMsgAccount")} />;
  }

  // Sessions minted before the email field existed fall back to a short userId prefix.
  const subtitle = email ?? (userId ? `id: ${userId.slice(0, 8)}…` : "—");
  return (
    <div class="acct-list">
      <IconRow rowClass="row arow" icon={ICON_USER} label={t("signedInLabel")} hint={subtitle} hintTitle={email ?? undefined}>
        <button
          class="linkish"
          type="button"
          onClick={() => {
            void sendRuntimeMessage({ type: "auth:signOut" })
              .catch(() => undefined)
              .finally(refresh);
          }}
        >
          {t("signOutBtn")}
        </button>
      </IconRow>
      <HistoryDataSection />
      <AnalyticsConsentSection settings={settings} update={update} />
      <DeleteAccountRow refresh={refresh} />
    </div>
  );
};

export { AccountView };
