// SPDX-License-Identifier: GPL-3.0-or-later
import { type ComponentChild, Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { accountLabel } from "../../shared/account-label";
import { ACCOUNT_NAME_MAX, accountDisplayName, accountOrdinal, providerTag, setAccountName } from "../../shared/account-names";
import { removeTechnicalAndInteractionConsent, requestTechnicalAndInteractionConsent } from "../../shared/data-consent";
import { getEmojiLabel, onLocalesChanged } from "../../shared/emoji-meta";
import { type EpochKeyLimitNotice, readEpochKeyLimitNotice } from "../../shared/epoch-key-limit";
import { t } from "../../shared/i18n";
import { ACCOUNT_LIST_CLASS, ACCOUNT_NAME_CLASS, ACCOUNT_NAME_INPUT_CLASS, DELETE_CONFIRM_WARN_CLASS, DEVICE_LIMIT_NOTICE_CLASS } from "../../shared/page-dom";
import type { Settings } from "../../shared/storage";
import { HELP_DEVICE_LIMIT_URL, withExtensionUtm } from "../../shared/tracking-links";
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
  // back to the button that armed the confirm (WCAG). Nothing armed the first render.
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
              <p class={DELETE_CONFIRM_WARN_CLASS}>{t("deleteAccountConfirm")}</p>
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

// The day voting resumes, in the UI locale. An engine that rejects the tag
// falls back to its default formatting rather than showing no date.
function resumeDayLabel(resumesAt: number): string {
  const date = new Date(resumesAt);
  try {
    return date.toLocaleDateString(navigator.language || undefined, { year: "numeric", month: "long", day: "numeric" });
  } catch {
    return date.toLocaleDateString();
  }
}

// Shown while the API is refusing this device's votes until the date it names
// (shared/epoch-key-limit.ts). Nothing else in the popup says so, and a reader
// whose reactions silently stop landing has no other way to find out.
const DeviceLimitNotice = () => {
  const [notice, setNotice] = useState<EpochKeyLimitNotice | null>(null);
  useEffect(() => {
    void readEpochKeyLimitNotice()
      .then(setNotice)
      .catch(() => setNotice(null));
  }, []);
  if (!notice) return null;
  return (
    <p class={DEVICE_LIMIT_NOTICE_CLASS} role="status">
      {t("voteDeviceLimit", resumeDayLabel(notice.resumesAt))}{" "}
      <a class="linkish" href={withExtensionUtm(HELP_DEVICE_LIMIT_URL, { campaign: "auth_device_limit", content: "popup" })} target="_blank" rel="noopener noreferrer">
        {t("deviceLimitHelpLink")}
      </a>
    </p>
  );
};

// The name shown for the signed-in account, and the field that renames it. The
// name is the reader's own or the emoji mark derived from the account id
// (shared/account-label.ts) - with the `openid` scope alone there is no address to
// show, and someone with two accounts at one provider still has to tell them apart.
const AccountName = ({ userId }: { userId: string }) => {
  // The derived label first, synchronously: it needs no storage read, so the row
  // never renders an account without a name and then pops one in. A name the reader
  // typed replaces it when the read lands.
  const [name, setName] = useState(() => accountLabel(userId));
  // The mark's name in the reader's language, for the tooltip. getEmojiLabel answers
  // the emoji itself until the locale file lands and starts that load, so the mark is
  // never waiting on it; the subscription is what repaints once it has.
  const [, repaint] = useState(0);
  useEffect(() => onLocalesChanged(() => repaint((n) => n + 1)), []);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setName(accountLabel(userId));
    void accountDisplayName(userId)
      .then(setName)
      .catch(() => {});
  }, [userId]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = async (value: string) => {
    setEditing(false);
    await setAccountName(userId, value).catch(() => {});
    await accountDisplayName(userId)
      .then(setName)
      .catch(() => {});
  };

  if (!editing) {
    return (
      <button
        class={`linkish ${ACCOUNT_NAME_CLASS}`}
        type="button"
        // The emoji's own name where the name IS the mark; a name the reader typed
        // needs no gloss, so there the tooltip stays the control's purpose.
        title={name === accountLabel(userId) ? getEmojiLabel(name) : t("accountRenameBtn")}
        onClick={() => {
          setDraft(name);
          setEditing(true);
        }}
      >
        {name}
      </button>
    );
  }
  return (
    <input
      class={ACCOUNT_NAME_INPUT_CLASS}
      ref={inputRef}
      type="text"
      value={draft}
      maxLength={ACCOUNT_NAME_MAX}
      // Sized to the longest name that can exist, so the placeholder and a full name
      // both read without the field scrolling; the row's max-width holds it there.
      size={ACCOUNT_NAME_MAX}
      aria-label={t("accountRenameBtn")}
      placeholder={t("accountNamePlaceholder")}
      onInput={(e: Event) => setDraft((e.target as HTMLInputElement).value)}
      onBlur={() => void commit(draft)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter") void commit(draft);
        // Escape leaves the stored name as it was, whatever the field holds.
        if (e.key === "Escape") setEditing(false);
      }}
    />
  );
};

const AccountView = ({ settings, update }: { settings: Settings; update: (patch: Partial<Settings>) => Promise<void> }) => {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [provider, setProvider] = useState<string | null>(null);
  // Which account of that provider this is on this device. 0 until the read lands and
  // for an account with no record to number it by, and providerTag then omits it.
  const [ordinal, setOrdinal] = useState(0);

  const refresh = () => {
    void sendRuntimeMessage({ type: "auth:status" })
      .then((resp) => {
        if (resp?.type === "auth:status") {
          setAuthed(resp.authed);
          setUserId(resp.userId);
          setProvider(resp.provider);
          if (resp.userId)
            void accountOrdinal(resp.userId)
              .then(setOrdinal)
              .catch(() => {});
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
    // tied to the signed-in identity, so it has nothing to govern here.
    return <SignInPrompt message={t("signInMsgAccount")} />;
  }

  // "Apple #1 · spawrro": the provider and which of its accounts this is, then the
  // name - the only half the reader edits. The number identifies the account whatever
  // it ends up called, so renaming never costs the reader the way back to it.
  return (
    <div class={ACCOUNT_LIST_CLASS}>
      <IconRow rowClass="row arow" icon={ICON_USER} label={t("signedInLabel")} hint={provider ? providerTag(provider, ordinal) : ""} hintTail={userId ? <AccountName userId={userId} /> : undefined}>
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
      <DeviceLimitNotice />
      <HistoryDataSection />
      <AnalyticsConsentSection settings={settings} update={update} />
      <DeleteAccountRow refresh={refresh} />
    </div>
  );
};

export { AccountView };
