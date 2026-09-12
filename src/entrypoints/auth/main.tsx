// SPDX-License-Identifier: GPL-3.0-or-later
//
// Auth page for the extension's email-code sign-in flow.

import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type I18nKey, t } from "../../shared/i18n";
import type { OtpRequestRefusal, OtpVerifyRefusal, RuntimeResponse } from "../../shared/messages";
import { bootstrapPage } from "../../shared/page-bootstrap";
import { AGREE_CLASS, AUTH_ERROR_CLASS, AUTH_ERROR_ID, CARD_CLASS, CODE_INPUT_ID, COUNTDOWN_CLASS, EMAIL_INPUT_ID, NOTICE_CLASS, TAGLINE_CLASS } from "../../shared/page-dom";
import { withExtensionUtm } from "../../shared/tracking-links";
import { sendRuntimeMessage } from "../../shared/webext";
import { getOtpCooldown, OTP_COOLDOWN_FALLBACK_SECONDS, OTP_RESEND_COOLDOWN_SECONDS, type OtpCooldown, setOtpCooldown } from "./otp-cooldown";
import { cooldownMessageKey, EMAIL_SHAPE, formatCountdown } from "./otp-format";

// Fresh installs on pre-140 Firefox open this page with `?consent=1` (background/install.ts) to get
// the data-collection disclosure their browser is too old to show itself.
const CONSENT_ONLY = typeof location !== "undefined" && new URLSearchParams(location.search).get("consent") === "1";

bootstrapPage(CONSENT_ONLY ? t("dataConsentTitle") : t("authPageTitle"), true);

type Step = "email" | "code" | "done";

type OtpRequested = Extract<RuntimeResponse, { type: "auth:otpRequested" }>;
type OtpVerified = Extract<RuntimeResponse, { type: "auth:otpVerified" }>;

// The copy each named refusal gets. `rate_limited` is absent on purpose: it arms a
// cooldown instead of a line (see requestCode). `client_outdated` is the one
// refusal whose fix is on the user's side (update from the store), so it gets its
// own line instead of the generic fallback.
const REQUEST_REFUSAL_COPY: Record<Exclude<OtpRequestRefusal, "rate_limited">, I18nKey> = {
  invalid_email: "authErrBadEmail",
  email_rejected: "authErrEmailDomainUndeliverable",
  delivery_failed: "authErrUndeliverable",
  client_outdated: "authErrOutdated",
  unavailable: "authErrUnknown",
};

const VERIFY_REFUSAL_COPY: Record<OtpVerifyRefusal, I18nKey> = {
  code_invalid: "authErrCodeInvalid",
  locked: "authErrTooManyTries",
  client_outdated: "authErrOutdated",
  unavailable: "authErrVerifyFailed",
};

// The exchange itself runs in the service worker (background/message-router), not
// here: whatever it comes back with belongs where it is used, and a page is not
// that place. An answer that is not the exchange's own envelope (the background's
// generic error, a dropped channel) reads as the generic refusal.
async function askRequestOtp(email: string): Promise<OtpRequested> {
  const res = await sendRuntimeMessage({ type: "auth:requestOtp", email }).catch(() => undefined);
  return res?.type === "auth:otpRequested" ? res : { type: "auth:otpRequested", ok: false, refusal: "unavailable" };
}

async function askVerifyOtp(email: string, code: string): Promise<OtpVerified> {
  const res = await sendRuntimeMessage({ type: "auth:verifyOtp", email, code }).catch(() => undefined);
  return res?.type === "auth:otpVerified" ? res : { type: "auth:otpVerified", ok: false, refusal: "unavailable" };
}

type CodeStepProps = {
  email: string;
  code: string;
  error: string | null;
  busy: boolean;
  remainingSec: number;
  cooldown: OtpCooldown | null;
  onVerify: (e: Event) => void;
  onResend: () => void;
  onUseDifferentEmail: () => void;
  setCode: (value: string) => void;
};

function CodeStep({ email, code, error, busy, remainingSec, cooldown, onVerify, onResend, onUseDifferentEmail, setCode }: CodeStepProps) {
  return (
    <main class="wrap">
      {/* Distinct key per step so Preact mounts a FRESH <form>/<input> subtree. Without it the
          email <input> inherited this code input's maxLength/pattern/inputMode and rejected
          typing/paste after "use a different email" until a full page reload. */}
      <form key="code-step" class={CARD_CLASS} onSubmit={onVerify}>
        <h1>{t("authCodeTitle")}</h1>
        <p class={TAGLINE_CLASS}>{t("authCodeTagline", email)}</p>
        <label for="code-input">{t("authCodeLabel")}</label>
        <input
          id={CODE_INPUT_ID}
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]*"
          class="code-input"
          value={code}
          aria-describedby={error ? AUTH_ERROR_ID : undefined}
          aria-invalid={error ? "true" : undefined}
          onInput={(e: Event) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ""))}
        />
        {error ? (
          <div class={AUTH_ERROR_CLASS} id={AUTH_ERROR_ID} role="alert">
            {error}
          </div>
        ) : null}
        <button class="primary" type="submit" disabled={busy || code.length !== 6}>
          {busy ? t("authVerifyingBtn") : t("authVerifyBtn")}
        </button>
        <div class="code-actions">
          {/* Resend lives on the code screen so getting a new code never requires leaving it. */}
          <button class="linkish" type="button" disabled={busy || remainingSec > 0} onClick={onResend}>
            {/* A rate-limit hit stays disabled without a countdown. */}
            {remainingSec > 0 && cooldown?.reason !== "rateLimit" ? t("authResendInBtn", formatCountdown(remainingSec)) : t("authResendBtn")}
          </button>
          <button class="linkish" type="button" onClick={onUseDifferentEmail}>
            {t("authUseDifferentEmail")}
          </button>
        </div>
      </form>
    </main>
  );
}

// Long enough to read "You're signed in" and see where the tab is going, short
// enough that the reaction waiting on the other tab is still what the user is
// thinking about. "Stay here" turns it off (WCAG 2.2.1), and "Back to the page"
// skips the wait entirely.
const RETURN_DELAY_SECONDS = 10;

/** The last step. Plain "you can close this" unless the sign-in started from a
 *  page's gate and that tab is still open - then it takes the user back there, so
 *  the reaction the gate was holding is watched landing instead of missed. */
function DoneStep({ returnsToPage }: { returnsToPage: boolean }) {
  const [remaining, setRemaining] = useState(RETURN_DELAY_SECONDS);
  const [returning, setReturning] = useState(returnsToPage);
  const backRef = useRef<HTMLButtonElement>(null);
  // A click landing on the same tick the countdown expires would otherwise ask
  // twice; the second ask finds the marker already spent and reads as a failure.
  const returnSent = useRef(false);

  const goBack = useCallback(async () => {
    if (returnSent.current) return;
    returnSent.current = true;
    const res = await sendRuntimeMessage({ type: "auth:returnToOrigin" }).catch(() => undefined);
    // On success the background closes this tab, so nothing below ever repaints.
    // On failure the origin tab went away mid-countdown - the one thing that
    // stops the countdown, and the reason this step keeps its old copy at all.
    if (res?.type !== "ok") setReturning(false);
  }, []);

  useEffect(() => {
    if (!returning) return;
    if (remaining <= 0) {
      void goBack();
      return;
    }
    const id = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [returning, remaining, goBack]);

  // The primary action, focused as the step mounts: the Verify button it replaces
  // has just been removed, which would otherwise drop focus to the body.
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  if (!returning) {
    return (
      <main class="wrap">
        <div class={CARD_CLASS}>
          <h1>{t("authDoneTitle")}</h1>
          <p class={TAGLINE_CLASS}>{t("authDoneTagline")}</p>
        </div>
      </main>
    );
  }

  return (
    <main class="wrap">
      <div class={CARD_CLASS}>
        <h1>{t("authDoneTitle")}</h1>
        {/* Static text, so `status` announces the pending return exactly once - no
            live region tracks the seconds, which would announce every tick. */}
        <p class={TAGLINE_CLASS} role="status">
          {t("authDoneReturnTagline")}
        </p>
        {/* The bar and the digits say the same thing twice, for the eye and for the
            impatient; neither is the only carrier, so both are hidden from the a11y
            tree and the sentence above stands alone there. */}
        <div class={COUNTDOWN_CLASS} aria-hidden="true">
          <span class="track">
            <i style={{ animationDuration: `${RETURN_DELAY_SECONDS}s` }} />
          </span>
          <span class="seconds">{remaining}</span>
        </div>
        <button class="primary" type="button" ref={backRef} onClick={() => void goBack()}>
          {t("authDoneReturnNowBtn")}
        </button>
      </div>
    </main>
  );
}

type EmailStepProps = {
  email: string;
  error: string | null;
  busy: boolean;
  accepted: boolean;
  remainingSec: number;
  cooldown: OtpCooldown | null;
  onSendCode: (e: Event) => void;
  onEnterPendingCode: (pendingEmail: string) => void;
  setEmail: (value: string) => void;
  setAccepted: (value: boolean) => void;
};

function EmailStep({ email, error, busy, accepted, remainingSec, cooldown, onSendCode, onEnterPendingCode, setEmail, setAccepted }: EmailStepProps) {
  // One-shot screen-reader text, frozen at cooldown start (deps deliberately omit
  // `email`/time): the visible countdown re-renders every second, and a live region
  // tracking it would announce each tick.
  const cooldownAnnouncement = useMemo(() => (cooldown ? t(cooldownMessageKey(cooldown, email), formatCountdown(Math.max(0, Math.ceil((cooldown.until - Date.now()) / 1000)))) : ""), [cooldown]);
  return (
    <main class="wrap">
      {/* See the code-step key note - keeps this <input> a separate node from the code field. */}
      <form key="email-step" class={CARD_CLASS} onSubmit={onSendCode}>
        <h1>{t("authSignInTitle")}</h1>
        <p class={TAGLINE_CLASS}>{t("authSignInTagline")}</p>
        <label for="email-input">{t("authEmailLabel")}</label>
        <input id={EMAIL_INPUT_ID} type="email" autoComplete="email" required value={email} aria-describedby={error ? AUTH_ERROR_ID : undefined} aria-invalid={error ? "true" : undefined} onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)} />
        {remainingSec > 0 ? (
          cooldown?.reason === "rateLimit" ? (
            // 429 gets a generic message with no countdown; only the benign resend window shows a timer.
            <div class="error" role="alert">
              {t("authErrRateLimit")}
            </div>
          ) : (
            <div class={NOTICE_CLASS}>
              {/* The ticking line is aria-hidden; the sr-only copy (frozen at cooldown
                  start) carries the announcement so it fires once, not every second. */}
              <span aria-hidden="true">{t(cooldownMessageKey(cooldown, email), formatCountdown(remainingSec))}</span>
              <span class="sr-only" role="status">
                {cooldownAnnouncement}
              </span>
            </div>
          )
        ) : error ? (
          <div class={AUTH_ERROR_CLASS} id={AUTH_ERROR_ID} role="alert">
            {error}
          </div>
        ) : null}
        {/* Escape hatch: while a code is outstanding, keep a one-click path back to enter it,
            so "Use a different email" + the timer can never trap the user away from their code. */}
        {cooldown?.reason === "resend" ? (
          <button class="linkish" type="button" onClick={() => onEnterPendingCode(cooldown.email)}>
            {t("authEnterPendingCode", cooldown.email)}
          </button>
        ) : null}
        <label class={AGREE_CLASS}>
          <input type="checkbox" checked={accepted} onChange={(e: Event) => setAccepted((e.target as HTMLInputElement).checked)} />
          <span>
            {t("authAgreeIntro")}
            <a
              href={withExtensionUtm("https://emojery.app/terms", {
                campaign: "auth_consent_links",
                content: "terms_of_service",
              })}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("authTermsLinkLabel")}
            </a>
            {t("authAgreeConjunction")}
            <a
              href={withExtensionUtm("https://emojery.app/privacy", {
                campaign: "auth_consent_links",
                content: "privacy_policy",
              })}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("authPrivacyLinkLabel")}
            </a>
            {t("authAgreeOutro")}
          </span>
        </label>
        <button class="primary" type="submit" disabled={busy || !accepted || remainingSec > 0 || !EMAIL_SHAPE.test(email.trim())}>
          {busy ? t("authSendingBtn") : t("authSendCodeBtn")}
        </button>
      </form>
    </main>
  );
}

function App() {
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [cooldown, setCooldown] = useState<OtpCooldown | null>(null);
  const [returnsToPage, setReturnsToPage] = useState(false);
  const [nowTs, setNowTs] = useState(() => Date.now());
  const requestInFlight = useRef(false);

  const remainingSec = cooldown !== null ? Math.max(0, Math.ceil((cooldown.until - nowTs) / 1000)) : 0;

  // Restore a persisted cooldown on load (survives reload mid-window).
  useEffect(() => {
    setCooldown(getOtpCooldown());
  }, []);

  // The tab title follows the step: a tab strip full of pages still says which one
  // is waiting for the code and which one is done.
  useEffect(() => {
    document.title = t(step === "code" ? "authCodePageTitle" : step === "done" ? "authDonePageTitle" : "authPageTitle");
  }, [step]);

  useEffect(() => {
    if (cooldown === null) return;
    setNowTs(Date.now());
    const id = setInterval(() => {
      const now = Date.now();
      setNowTs(now);
      if (now >= cooldown.until) {
        setCooldown(null);
        clearInterval(id);
      }
    }, 1000);
    return () => clearInterval(id);
  }, [cooldown]);

  // Shared by "Send code" and "Resend code"; returns true on success so the caller can navigate.
  const requestCode = useCallback(async (trimmed: string): Promise<boolean> => {
    // Re-arm an active cooldown from cache instead of sending again.
    const cached = getOtpCooldown();
    if (cached) {
      setCooldown(cached);
      return false;
    }
    if (requestInFlight.current) return false;
    requestInFlight.current = true;
    setBusy(true);
    const res = await askRequestOtp(trimmed);
    requestInFlight.current = false;
    setBusy(false);
    if (res.ok) {
      setCooldown(setOtpCooldown(trimmed, OTP_RESEND_COOLDOWN_SECONDS, "resend"));
      return true;
    }
    if (res.refusal === "rate_limited") {
      const retryAfter = res.retryAfterSeconds || OTP_COOLDOWN_FALLBACK_SECONDS;
      setCooldown(setOtpCooldown(trimmed, retryAfter, "rateLimit"));
    } else {
      setError(t(REQUEST_REFUSAL_COPY[res.refusal]));
    }
    return false;
  }, []);

  const onSendCode = useCallback(
    async (e: Event) => {
      e.preventDefault();
      setError(null);
      const trimmed = email.trim();
      // Only pre-empt obviously malformed input; the server decides the rest.
      if (!EMAIL_SHAPE.test(trimmed)) {
        setError(t("authErrBadEmail"));
        return;
      }
      if (await requestCode(trimmed)) setStep("code");
    },
    [email, requestCode],
  );

  const onResend = useCallback(async () => {
    setError(null);
    await requestCode(email.trim());
  }, [email, requestCode]);

  const onVerify = useCallback(
    async (e: Event) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      const res = await askVerifyOtp(email.trim(), code.trim());
      setBusy(false);
      if (res.ok) {
        setReturnsToPage(res.returnsToPage === true);
        setStep("done");
        return;
      }
      setError(t(VERIFY_REFUSAL_COPY[res.refusal]));
    },
    [email, code],
  );

  // The two step transitions the form itself offers, so each step gets one callback
  // rather than the raw setters behind it.
  const useDifferentEmail = (): void => {
    setStep("email");
    setCode("");
    setError(null);
  };

  const enterPendingCode = (pendingEmail: string): void => {
    setEmail(pendingEmail);
    setCode("");
    setError(null);
    setStep("code");
  };

  useEffect(() => {
    // The done step has no field to land in - it focuses its own button instead.
    if (step === "done") return;
    const el = document.querySelector<HTMLInputElement>(step === "email" ? 'input[type="email"]' : 'input[name="code"]');
    el?.focus();
  }, [step]);

  if (step === "done") return <DoneStep returnsToPage={returnsToPage} />;

  if (step === "code") {
    return <CodeStep email={email} code={code} error={error} busy={busy} remainingSec={remainingSec} cooldown={cooldown} onVerify={onVerify} onResend={onResend} onUseDifferentEmail={useDifferentEmail} setCode={setCode} />;
  }

  return <EmailStep email={email} error={error} busy={busy} accepted={accepted} remainingSec={remainingSec} cooldown={cooldown} onSendCode={onSendCode} onEnterPendingCode={enterPendingCode} setEmail={setEmail} setAccepted={setAccepted} />;
}

// Shown ahead of the sign-in form on browsers that never prompted for data collection themselves.
// Read-only by design: the only toggleable bucket is `technicalAndInteraction`, and pre-140 Firefox
// rejects `permissions.request({ data_collection })`, so analytics is already forced off there
// (shared/data-consent.ts) and a toggle here could only ever fail.
function ConsentGate() {
  const [acknowledged, setAcknowledged] = useState(false);
  if (acknowledged) return <App />;
  return (
    <main class="wrap">
      <div class={CARD_CLASS}>
        <h1>{t("dataConsentTitle")}</h1>
        {/* The policy closes the paragraph as a sentence of its own - the short body
            above says what is sent, the link carries the detail it dropped. */}
        <p class={TAGLINE_CLASS}>
          {t("dataConsentBody")}{" "}
          <a
            href={withExtensionUtm("https://emojery.app/privacy", {
              campaign: "auth_consent_links",
              content: "legacy_data_consent",
            })}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("dataConsentPolicyLink")}
          </a>
        </p>
        <button class="primary" type="button" onClick={() => setAcknowledged(true)}>
          {t("dataConsentContinueBtn")}
        </button>
      </div>
    </main>
  );
}

render(CONSENT_ONLY ? <ConsentGate /> : <App />, document.getElementById("app")!);
