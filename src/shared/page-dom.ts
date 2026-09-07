// SPDX-License-Identifier: GPL-3.0-or-later
//
// The names of the extension's OWN pages - popup, auth, onboarding. Same contract
// shared/dom.ts holds for the injected DOM, for the other half of the UI: the
// components stamp these names, the component tests and the e2e probes read them,
// and the stylesheets spell the same strings out literally - so a rename here has
// to reach popup.css / auth.css / onboarding.css too.
//
// Only names a SECOND module needs live here. A class written and read inside one
// component stays in that component; add it here when a test or another page needs
// to name it as well.

// --- Popup shell (entrypoints/popup/main.tsx) ---

export const POPUP_CLASS = "popup";
export const POPUP_SELECTOR = `.${POPUP_CLASS}`;
// Version (and, in Debug mode, the build stamp): masked in visual baselines,
// since it changes every release.
export const BUILD_INFO_CLASS = "build-info";
export const BUILD_INFO_SELECTOR = `.${BUILD_INFO_CLASS}`;
// Each tab button's id is this prefix plus the view name; the roving-tabindex
// walk in main.tsx focuses them by that id.
export const TAB_ID_PREFIX = "em-tab-";
export const DEBUG_TAB_ID = `${TAB_ID_PREFIX}debug`;
export const DEBUG_TAB_SELECTOR = `#${DEBUG_TAB_ID}`;
export const TAB_PANEL_ID = "em-tabpanel";
export const TAB_PANEL_SELECTOR = `#${TAB_PANEL_ID}`;

// --- History rows, shared by the History tab and the Debug queue ---

export const HISTORY_CLASS = "history";
export const HISTORY_ROW_SELECTOR = `.${HISTORY_CLASS} li`;
export const HISTORY_DAY_CLASS = "history-day";
export const HISTORY_DAY_SELECTOR = `.${HISTORY_DAY_CLASS}`;
export const HISTORY_EMOJI_CLASS = "history-emoji";
export const HISTORY_EMOJI_SELECTOR = `.${HISTORY_EMOJI_CLASS}`;
export const HISTORY_LINK_CLASS = "history-link";
export const HISTORY_LINK_SELECTOR = `a.${HISTORY_LINK_CLASS}`;
export const HISTORY_MORE_CLASS = "history-more";
export const HISTORY_MORE_SELECTOR = `.${HISTORY_MORE_CLASS}`;
export const HISTORY_NOMATCH_CLASS = "history-nomatch";
export const HISTORY_NOMATCH_SELECTOR = `.${HISTORY_NOMATCH_CLASS}`;
// Row internals shared by both lists.
export const HISTORY_MID_CLASS = "history-mid";
export const HISTORY_TITLE_CLASS = "history-title";
export const HISTORY_TIME_CLASS = "history-time";
export const HISTORY_SEARCH_INPUT_CLASS = "history-search-input";
export const HISTORY_SEARCH_INPUT_SELECTOR = `.${HISTORY_SEARCH_INPUT_CLASS}`;

// --- History export / import (entrypoints/popup/popup-history-data.tsx) ---

export const DATA_FILE_CLASS = "data-file";
export const DATA_FILE_SELECTOR = `input.${DATA_FILE_CLASS}`;
export const DATA_STATUS_CLASS = "data-status";
export const DATA_STATUS_SELECTOR = `.${DATA_STATUS_CLASS}`;
export const IMPORT_CONFIRM_CLASS = "import-confirm";
export const IMPORT_CONFIRM_SELECTOR = `.${IMPORT_CONFIRM_CLASS}`;
export const IMPORT_CONFIRM_COUNT_CLASS = "import-confirm-count";
export const IMPORT_CONFIRM_COUNT_SELECTOR = `.${IMPORT_CONFIRM_COUNT_CLASS}`;

// --- Settings rows (entrypoints/popup/popup-settings.tsx) ---

// The Theme row's dropdown - the popup's only <select>.
export const ROW_SELECT_CLASS = "row-select";
export const ROW_SELECT_SELECTOR = `select.${ROW_SELECT_CLASS}`;

// --- Account tab (entrypoints/popup/popup-account.tsx) ---

export const ACCOUNT_LIST_CLASS = "acct-list";
export const ACCOUNT_LIST_SELECTOR = `.${ACCOUNT_LIST_CLASS}`;
export const DELETE_CONFIRM_WARN_CLASS = "delete-confirm-warn";
export const DELETE_CONFIRM_WARN_SELECTOR = `.${DELETE_CONFIRM_WARN_CLASS}`;

// --- Emoji sentiment editor (entrypoints/popup/popup-emoji-sentiment.tsx) ---

export const SENTIMENT_EDITOR_CLASS = "sentiment-editor";
export const SENTIMENT_EDITOR_SELECTOR = `.${SENTIMENT_EDITOR_CLASS}`;
export const SENTIMENT_ZONE_TITLE_CLASS = "sentiment-zone-title";
export const SENTIMENT_ZONE_TITLE_SELECTOR = `.${SENTIMENT_ZONE_TITLE_CLASS}`;
export const SENTIMENT_CHIP_CLASS = "sentiment-chip";
export const SENTIMENT_CHIP_SELECTOR = `.${SENTIMENT_CHIP_CLASS}`;

// --- Report tab (entrypoints/popup/popup-report.tsx) ---

export const REPORT_SUCCESS_CLASS = "report-success";
export const REPORT_SUCCESS_SELECTOR = `.${REPORT_SUCCESS_CLASS}`;
export const REPORT_ERROR_CLASS = "report-error";
export const REPORT_ERROR_SELECTOR = `.${REPORT_ERROR_CLASS}`;
export const REPORT_NOTE_HINT_ID = "report-note-hint";
export const REPORT_NOTE_HINT_SELECTOR = `#${REPORT_NOTE_HINT_ID}`;
// Also the Report tab's "this page is not supported" line.
export const EMPTY_NOTE_CLASS = "empty-note";
export const EMPTY_NOTE_SELECTOR = `.${EMPTY_NOTE_CLASS}`;

// --- Chrome shared by popup, auth and onboarding ---

export const CARD_CLASS = "card";
export const CARD_SELECTOR = `.${CARD_CLASS}`;
export const TAGLINE_CLASS = "tagline";
export const TAGLINE_SELECTOR = `.${TAGLINE_CLASS}`;
export const SIGNIN_PROMPT_MSG_CLASS = "signin-prompt-msg";
export const SIGNIN_PROMPT_MSG_SELECTOR = `.${SIGNIN_PROMPT_MSG_CLASS}`;
export const TOOLTIP_POP_CLASS = "tt-pop";
export const TOOLTIP_POP_SELECTOR = `.${TOOLTIP_POP_CLASS}`;

// --- Auth page (entrypoints/auth/main.tsx) ---

export const EMAIL_INPUT_ID = "email-input";
export const EMAIL_INPUT_SELECTOR = `#${EMAIL_INPUT_ID}`;
export const CODE_INPUT_ID = "code-input";
export const CODE_INPUT_SELECTOR = `#${CODE_INPUT_ID}`;
export const AUTH_ERROR_ID = "auth-error";
export const AUTH_ERROR_SELECTOR = `#${AUTH_ERROR_ID}`;
export const AUTH_ERROR_CLASS = "error";
// The throttle/cooldown banner above the form.
export const NOTICE_CLASS = "notice";
export const NOTICE_SELECTOR = `.${NOTICE_CLASS}`;
// The resend timer beside the code field.
export const COUNTDOWN_CLASS = "countdown";
export const COUNTDOWN_SELECTOR = `.${COUNTDOWN_CLASS}`;

// --- Onboarding page (entrypoints/onboarding/main.tsx) ---

export const CONFETTI_CLASS = "confetti";
export const CONFETTI_SELECTOR = `.${CONFETTI_CLASS}`;
