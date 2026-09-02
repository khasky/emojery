// SPDX-License-Identifier: GPL-3.0-or-later
import { type ComponentChild, Fragment } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { errorCopyKey, failureCode } from "../../shared/error-copy";
import { t } from "../../shared/i18n";
import { HISTORY_EXPORT_SCHEMA_VERSION, HISTORY_IMPORT_MAX, type HistoryExportFile, type PortableHistoryRow } from "../../shared/messages";
import { sendRuntimeMessage } from "../../shared/webext";
import { BUILD_VERSION, IconRow } from "./popup-shared";

const ICON_EXPORT: ComponentChild[] = [<path d="M12 3.5v9m0 0l-3.4-3.4M12 12.5l3.4-3.4M4.5 16v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V16" />];
const ICON_IMPORT: ComponentChild[] = [<path d="M12 13.5v-9m0 0L8.6 7.9M12 4.5l3.4 3.4M4.5 16v2.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V16" />];

function exportDateStamp(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// The object URL is revoked only after this grace period, since the popup may
// already be closing when the download starts.
const OBJECT_URL_REVOKE_GRACE_MS = 10_000;

// A user-gesture anchor download needs no "downloads" permission.
function downloadHistoryFile(rows: PortableHistoryRow[]): void {
  const payload: HistoryExportFile = {
    format: "emojery-history",
    schemaVersion: HISTORY_EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    app: { name: "Emojery", version: BUILD_VERSION },
    reactions: rows,
  };
  const blob = new Blob([JSON.stringify(payload)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `emojery-history-${exportDateStamp()}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), OBJECT_URL_REVOKE_GRACE_MS);
}

// Require the `format` marker so an unrelated JSON can't trigger a replacing import.
// The background re-validates every row regardless - including the same
// HISTORY_IMPORT_MAX bound, which is checked here too so an over-cap file fails
// with the import error instead of the guard dropping the message and the popup
// reading that as a generic round-trip failure.
function parseImportRows(text: string): PortableHistoryRow[] | null {
  try {
    const parsed = JSON.parse(text) as Partial<HistoryExportFile>;
    if (!parsed || typeof parsed !== "object" || parsed.format !== "emojery-history" || !Array.isArray(parsed.reactions)) return null;
    if (parsed.reactions.length > HISTORY_IMPORT_MAX) return null;
    return parsed.reactions as PortableHistoryRow[];
  } catch {
    return null;
  }
}

// A picked file arms a confirmation (current to incoming counts) before the replacing
// import - the restore-on-a-fresh-browser path - writes anything; Export hides when there's nothing to save.
export const HistoryDataSection = () => {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const importButtonRef = useRef<HTMLButtonElement | null>(null);
  const wasPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // Three states, because import REPLACES the stored history and the confirm below
  // prints this number as "what you are about to lose": `undefined` = the first read
  // is still in flight, `null` = the read FAILED (or came back unauthed), a number =
  // known. A failed read must not fall back to 0 - that reads as "nothing to lose"
  // and is exactly the reassurance the user must not be given.
  const [storedRowCount, setStoredRowCount] = useState<number | null>();
  const [pendingImportRows, setPendingImportRows] = useState<PortableHistoryRow[] | null>(null);

  const refreshTotal = () => {
    void sendRuntimeMessage({ type: "history:stats" })
      .then((resp) => {
        setStoredRowCount(resp?.type === "history:stats" && resp.authed ? resp.stats.total : null);
      })
      // Not swallowed: the count drops to "unknown" so the confirm shows `?` rather
      // than a stale total from before the import, or a fabricated 0.
      .catch(() => setStoredRowCount(null));
  };
  useEffect(refreshTotal, []);

  // Picking a file disables the Import button that armed this confirm, so the browser
  // drops focus to <body>; move it onto the confirm instead - and back onto Import when
  // the confirm goes away, since it takes the focused button with it (WCAG 2.4.3).
  useEffect(() => {
    if (pendingImportRows) confirmRef.current?.focus();
    else if (wasPending.current) importButtonRef.current?.focus();
    wasPending.current = pendingImportRows !== null;
  }, [pendingImportRows]);

  // A failed export must say so, not end in no file and no message.
  const onExport = () => {
    setStatus(null);
    setBusy(true);
    void sendRuntimeMessage({ type: "history:export" })
      .then((resp) => {
        if (resp?.type === "history:export" && resp.authed) downloadHistoryFile(resp.rows);
        else setStatus(t(errorCopyKey(failureCode(resp), "loadError")));
      })
      .catch(() => setStatus(t("loadError")))
      .finally(() => setBusy(false));
  };

  const onFile = (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // let the same file be re-picked after a cancel/failure
    if (!file) return;
    setStatus(null);
    void file
      .text()
      .then((text) => {
        const rows = parseImportRows(text);
        if (!rows) setStatus(t("importError"));
        else setPendingImportRows(rows);
      })
      .catch(() => setStatus(t("importError")));
  };

  const confirmReplace = () => {
    if (!pendingImportRows) return;
    const rows = pendingImportRows;
    setPendingImportRows(null);
    setBusy(true);
    void sendRuntimeMessage({ type: "history:import", rows })
      .then((resp) => {
        if (resp?.type === "history:import" && resp.authed) {
          setStatus(t("importDone", String(resp.imported)));
          refreshTotal();
        } else {
          setStatus(t("importError"));
        }
      })
      .catch(() => setStatus(t("importError")))
      .finally(() => setBusy(false));
  };

  return (
    <Fragment>
      {/* Hidden only while the first read is in flight or the account is known to have
          nothing to save. An UNKNOWN count (failed read) still offers Export - a
          stats failure must not be what strands a user's history in the browser. */}
      {storedRowCount !== undefined && storedRowCount !== 0 ? (
        <IconRow rowClass="row arow" icon={ICON_EXPORT} label={t("exportRowLabel")} hint={t("exportRowHint")}>
          <button class="linkish" type="button" disabled={busy || pendingImportRows !== null} onClick={onExport}>
            {t("exportBtn")}
          </button>
        </IconRow>
      ) : null}
      <IconRow rowClass="row arow" icon={ICON_IMPORT} label={t("importRowLabel")} hint={t("importRowHint")}>
        <button ref={importButtonRef} class="linkish" type="button" disabled={busy || pendingImportRows !== null} onClick={() => fileRef.current?.click()}>
          {t("importBtn")}
        </button>
        <input ref={fileRef} type="file" accept="application/json,.json" class="data-file" onChange={onFile} />
      </IconRow>
      {pendingImportRows ? (
        <div class="import-confirm">
          <p class="import-confirm-warn" role="status">
            {t("importReplaceWarn")}
          </p>
          {/* The arrow reads as "right arrow" (or nothing) to a screen reader, so the
              figure this dialog turns on is spelled out in the sr-only copy beside it. */}
          <p class="import-confirm-count" aria-hidden="true">{`${storedRowCount ?? "?"} → ${pendingImportRows.length}`}</p>
          <span class="sr-only">{t("importReplaceCountAria", [String(storedRowCount ?? "?"), String(pendingImportRows.length)])}</span>
          <div class="import-confirm-actions">
            <button ref={confirmRef} class="primary danger" type="button" onClick={confirmReplace}>
              {t("importReplaceConfirm")}
            </button>
            <button class="linkish" type="button" onClick={() => setPendingImportRows(null)}>
              {t("cancelBtn")}
            </button>
          </div>
        </div>
      ) : null}
      {status ? (
        <span class="data-status" role="status">
          {status}
        </span>
      ) : null}
    </Fragment>
  );
};
