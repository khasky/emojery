// SPDX-License-Identifier: GPL-3.0-or-later
import type { ComponentChild } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { SupportedSite } from "../../shared/adapter";
import { errorCopyKey } from "../../shared/error-copy";
import { t } from "../../shared/i18n";
import { NOTE_MAX, type RuntimeErrorCode } from "../../shared/messages";
import { reportPageUrl } from "../../shared/report-url";
import { safeHttpHref } from "../../shared/safe-href";
import { detectSupportedSite, SITE_LABELS } from "../../shared/sites";
import { sendRuntimeMessage } from "../../shared/webext";
import { brandIcon, SignInPrompt, shortenUrl, svgIcon, useActiveTabUrl, useAutoFocus } from "./popup-shared";

const MIN_REPORT_NOTE_CHARS = 10;

const ICON_EXT: ComponentChild[] = [<path d="M14 5h5v5M19 5l-8 8" />, <path d="M18 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 18V8a1.5 1.5 0 0 1 1.5-1.5H11" />];
const ICON_CHECK: ComponentChild[] = [<path d="M5 12.5l4.2 4.2L19 7" />];
const ICON_SEND: ComponentChild[] = [<path d="M4.5 11.5 20 5l-6.2 15-3.3-6.4-6-2.1Z" />, <path d="M20 5l-9.5 8.6" />];

type TabInfo = { state: "loading" } | { state: "unsupported" } | { state: "supported"; host: string; site: SupportedSite; url: string };
type SupportedTab = Extract<TabInfo, { state: "supported" }>;

// role="status" announces the swap; focus moves to the remaining control because the
// Send button this replaces just unmounted.
const ReportSuccess = ({ onAnother }: { onAnother: () => void }) => {
  const anotherRef = useRef<HTMLButtonElement | null>(null);
  useAutoFocus(anotherRef);
  return (
    <section class="report">
      <div class="report-success" role="status">
        <span class="report-success-ring">{svgIcon(ICON_CHECK, "check-icon")}</span>
        <b>{t("reportSent")}</b>
        <button ref={anotherRef} class="linkish" type="button" onClick={onAnother}>
          {t("reportAnother")}
        </button>
      </div>
    </section>
  );
};

// `sendError` carries the background's classification, not just "it failed": `null` is no
// error, `"unavailable"` (or a rejected message) keeps the generic report wording, and the
// codes a user can act on say which one it is. See shared/error-copy.ts.
type SendError = RuntimeErrorCode | null;

const ReportForm = ({ tab, note, setNote, canSubmit, noteTooShort, sendError, submit, autoFocus }: { tab: SupportedTab; note: string; setNote: (value: string) => void; canSubmit: boolean; noteTooShort: boolean; sendError: SendError; submit: () => void; autoFocus?: boolean }) => {
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  // Leaving the success panel unmounts the "Report another" button that held focus, so the
  // returning form takes it onto the note field. A first open is left alone.
  useAutoFocus(noteRef, autoFocus);
  return (
    <section class="report">
      {/* Contextual header - the detected site + page URL, and the whole row links
          out to the page being reported (the external-link icon signals it). */}
      <a class="report-head" href={safeHttpHref(tab.url) ?? undefined} target="_blank" rel="noopener noreferrer">
        {brandIcon(tab.site)}
        <div class="report-head-txt">
          <b>{SITE_LABELS[tab.site]}</b>
          <span title={tab.url}>{shortenUrl(tab.url)}</span>
        </div>
        {svgIcon(ICON_EXT, "row-icon")}
      </a>
      <textarea ref={noteRef} placeholder={t("reportPlaceholder")} aria-label={t("reportPlaceholder")} aria-describedby={noteTooShort ? "report-note-hint" : undefined} value={note} onInput={(e: Event) => setNote((e.currentTarget as HTMLTextAreaElement).value)} maxLength={NOTE_MAX} required />
      {noteTooShort ? (
        <p class="report-hint" id="report-note-hint">
          {t("reportPlaceholder")}
        </p>
      ) : null}
      {sendError !== null ? (
        <p class="report-error" role="alert">
          {t(errorCopyKey(sendError, "reportSendError"))}
        </p>
      ) : null}
      <button class="primary report-send" onClick={submit} type="button" disabled={!canSubmit}>
        {svgIcon(ICON_SEND, "send-glyph")}
        {t("reportSendBtn")}
      </button>
    </section>
  );
};

// A tab the query hasn't answered for yet stays "loading"; anything the extension can't
// report on (no URL, chrome://, an unsupported host) is "unsupported".
const describeTab = (url: URL | null | undefined): TabInfo => {
  if (url === undefined) return { state: "loading" };
  const site = url && detectSupportedSite(url.host);
  if (!url || !site) return { state: "unsupported" };
  return { state: "supported", host: url.host, site, url: reportPageUrl(url, site) };
};

const ReportView = () => {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const activeTabUrl = useActiveTabUrl();
  const tab = describeTab(activeTabUrl);
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [sendError, setSendError] = useState<SendError>(null);
  // Latched when the success panel is dismissed, so the remounted form knows to take focus.
  const returningFromSent = useRef(false);

  useEffect(() => {
    void sendRuntimeMessage({ type: "auth:status" })
      .then((resp) => {
        setAuthed(resp?.type === "auth:status" ? resp.authed : false);
      })
      .catch(() => setAuthed(false));
  }, []);

  const trimmedNote = note.trim();
  const canSubmit = tab.state === "supported" && trimmedNote.length >= MIN_REPORT_NOTE_CHARS;
  // The placeholder states the length rule but vanishes on the first keystroke - exactly when
  // the rule starts to bite - so repeat it under the field until the note is long enough (WCAG 3.3.2).
  const noteTooShort = trimmedNote.length > 0 && trimmedNote.length < MIN_REPORT_NOTE_CHARS;

  const submit = () => {
    if (!canSubmit || tab.state !== "supported") return;
    setSendError(null);
    void sendRuntimeMessage({
      type: "report",
      site: tab.site,
      host: tab.host,
      url: tab.url,
      // Required by the validated report envelope (message-guard); the popup runs no scan, so it is always 0.
      targetCount: 0,
      note: trimmedNote.slice(0, NOTE_MAX),
    })
      .then((resp) => {
        // A failed submit must not fail silently - the note stays in the form,
        // the error explains why nothing happened (WCAG 3.3.1). The background's
        // classification decides HOW it explains it; anything that is not an error
        // response falls back to the generic report wording.
        if (resp?.type === "ok") setSent(true);
        else setSendError(resp?.type === "error" ? resp.code : "unavailable");
      })
      .catch(() => setSendError("unavailable"));
  };

  if (authed === null || tab.state === "loading") return <section class="report" />;

  if (!authed) return <SignInPrompt message={t("signInMsgReport")} />;

  if (tab.state === "unsupported")
    return (
      <section class="report">
        <p class="empty-note">{t("reportUnsupportedPage")}</p>
      </section>
    );
  if (sent)
    return (
      <ReportSuccess
        onAnother={() => {
          setSent(false);
          setNote("");
          returningFromSent.current = true;
        }}
      />
    );

  return <ReportForm tab={tab} note={note} setNote={setNote} canSubmit={canSubmit} noteTooShort={noteTooShort} sendError={sendError} submit={submit} autoFocus={returningFromSent.current} />;
};

export { ReportView };
