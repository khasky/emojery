// SPDX-License-Identifier: GPL-3.0-or-later
//
// Auth page for the extension's email-code sign-in flow.

import { render } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { t } from "../../shared/i18n";
import type { RuntimeMessage } from "../../shared/messages";
import { bootstrapPage } from "../../shared/page-bootstrap";
import { withExtensionUtm } from "../../shared/tracking-links";
import { sendRuntimeMessage } from "../../shared/webext";
import { getOtpCooldown, OTP_COOLDOWN_FALLBACK_SECONDS, OTP_RESEND_COOLDOWN_SECONDS, type OtpCooldown, setOtpCooldown } from "./otp-cooldown";
import { cooldownMessageKey, EMAIL_SHAPE, formatCountdown } from "./otp-format";

// Fresh installs on pre-140 Firefox open this page with `?consent=1` (background/install.ts) to get
// the data-collection disclosure their browser is too old to show itself.
const CONSENT_ONLY = typeof location !== "undefined" && new URLSearchParams(location.search).get("consent") === "1";

bootstrapPage(CONSENT_ONLY ? t("dataConsentTitle") : t("authPageTitle"), true);

type Step = "email" | "code" | "done";

interface OtpOutcome {
  ok: boolean;
  status: number;
  error?: string;
  retryAfterSeconds?: number;
}

// `status: 0` is this page's "never reached the API" marker, distinct from every
// real HTTP status the mapping below branches on. It carries no `error` text, so
// the localized authErrUnknown/authErrVerifyFailed fallbacks render for it.
const OTP_UNREACHABLE: OtpOutcome = { ok: false, status: 0 };

// The exchange itself runs in the service worker (background/message-router), not
// here: whatever it comes back with belongs where it is used, and a page is not
// that place.
async function askOtp(msg: Extract<RuntimeMessage, { type: "auth:requestOtp" | "auth:verifyOtp" }>): Promise<OtpOutcome> {
  const res = await sendRuntimeMessage(msg).catch(() => undefined);
  return res?.type === "auth:otpRequested" || res?.type === "auth:otpVerified" ? res : OTP_UNREACHABLE;
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
  setCode: (value: string) => void;
  setStep: (value: Step) => void;
  setError: (value: string | null) => void;
};

function CodeStep({ email, code, error, busy, remainingSec, cooldown, onVerify, onResend, setCode, setStep, setError }: CodeStepProps) {
  return (
    <main class="wrap">
      {/* Distinct key per step so Preact mounts a FRESH <form>/<input> subtree. Without it the
          email <input> inherited this code input's maxLength/pattern/inputMode and rejected
          typing/paste after "use a different email" until a full page reload. */}
      <form key="code-step" class="card" onSubmit={onVerify}>
        <h1>{t("authCodeTitle")}</h1>
        <p class="tagline">{t("authCodeTagline", email)}</p>
        <label for="code-input">{t("authCodeLabel")}</label>
        <input
          id="code-input"
          name="code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]*"
          class="code-input"
          value={code}
          aria-describedby={error ? "auth-error" : undefined}
          aria-invalid={error ? "true" : undefined}
          onInput={(e: Event) => setCode((e.target as HTMLInputElement).value.replace(/\D/g, ""))}
        />
        {error ? (
          <div class="error" id="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        <button class="primary" type="submit" disabled={busy || code.length !== 6}>
          {busy ? t("authVerifyingBtn") : t("authVerifyBtn")}
        </button>
        <div class="code-actions">
          {/* Resend lives on the code screen so getting a new code never requires leaving it. */}
          <button class="linkish" type="button" disabled={busy || remainingSec > 0} onClick={onResend}>
            {remainingSec > 0
              ? cooldown?.reason === "rateLimit"
                ? t("authResendBtn") // disabled; no countdown for a rate-limit hit
                : t("authResendInBtn", formatCountdown(remainingSec))
              : t("authResendBtn")}
          </button>
          <button
            class="linkish"
            type="button"
            onClick={() => {
              setStep("email");
              setCode("");
              setError(null);
            }}
          >
            {t("authUseDifferentEmail")}
          </button>
        </div>
      </form>
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
  setEmail: (value: string) => void;
  setCode: (value: string) => void;
  setStep: (value: Step) => void;
  setError: (value: string | null) => void;
  setAccepted: (value: boolean) => void;
};

function EmailStep({ email, error, busy, accepted, remainingSec, cooldown, onSendCode, setEmail, setCode, setStep, setError, setAccepted }: EmailStepProps) {
  // One-shot screen-reader text, frozen at cooldown start (deps deliberately omit
  // `email`/time): the visible countdown re-renders every second, and a live region
  // tracking it would announce each tick.
  const cooldownAnnouncement = useMemo(() => (cooldown ? t(cooldownMessageKey(cooldown, email), formatCountdown(Math.max(0, Math.ceil((cooldown.until - Date.now()) / 1000)))) : ""), [cooldown]);
  return (
    <main class="wrap">
      {/* See the code-step key note - keeps this <input> a separate node from the code field. */}
      <form key="email-step" class="card" onSubmit={onSendCode}>
        <h1>{t("authSignInTitle")}</h1>
        <p class="tagline">{t("authSignInTagline")}</p>
        <label for="email-input">{t("authEmailLabel")}</label>
        <input id="email-input" type="email" autoComplete="email" required value={email} aria-describedby={error ? "auth-error" : undefined} aria-invalid={error ? "true" : undefined} onInput={(e: Event) => setEmail((e.target as HTMLInputElement).value)} />
        {remainingSec > 0 ? (
          cooldown?.reason === "rateLimit" ? (
            // 429 gets a generic message with no countdown; only the benign resend window shows a timer.
            <div class="error" role="alert">
              {t("authErrRateLimit")}
            </div>
          ) : (
            <div class="notice">
              {/* The ticking line is aria-hidden; the sr-only copy (frozen at cooldown
                  start) carries the announcement so it fires once, not every second. */}
              <span aria-hidden="true">{t(cooldownMessageKey(cooldown, email), formatCountdown(remainingSec))}</span>
              <span class="sr-only" role="status">
                {cooldownAnnouncement}
              </span>
            </div>
          )
        ) : error ? (
          <div class="error" id="auth-error" role="alert">
            {error}
          </div>
        ) : null}
        {/* Escape hatch: while a code is outstanding, keep a one-click path back to enter it,
            so "Use a different email" + the timer can never trap the user away from their code. */}
        {cooldown?.reason === "resend" ? (
          <button
            class="linkish"
            type="button"
            onClick={() => {
              setEmail(cooldown.email);
              setCode("");
              setError(null);
              setStep("code");
            }}
          >
            {t("authEnterPendingCode", cooldown.email)}
          </button>
        ) : null}
        <label class="agree">
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
  const [nowTs, setNowTs] = useState(() => Date.now());
  const requestInFlight = useRef(false);

  const remainingSec = cooldown !== null ? Math.max(0, Math.ceil((cooldown.until - nowTs) / 1000)) : 0;

  // Restore a persisted cooldown on load (survives reload mid-window).
  useEffect(() => {
    setCooldown(getOtpCooldown());
  }, []);

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
    const res = await askOtp({ type: "auth:requestOtp", email: trimmed });
    requestInFlight.current = false;
    setBusy(false);
    if (res.ok) {
      setCooldown(setOtpCooldown(trimmed, OTP_RESEND_COOLDOWN_SECONDS, "resend"));
      return true;
    }
    if (res.status === 429) {
      const retryAfter = res.retryAfterSeconds || OTP_COOLDOWN_FALLBACK_SECONDS;
      setCooldown(setOtpCooldown(trimmed, retryAfter, "rateLimit"));
    } else if (res.status === 502) {
      setError(t("authErrUndeliverable"));
    } else if (res.status === 422) {
      setError(t("authErrEmailNotAccepted"));
    } else if (res.status === 400) {
      setError(t("authErrBadEmail"));
    } else {
      setError(res.error ?? t("authErrUnknown"));
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
      const res = await askOtp({ type: "auth:verifyOtp", email: email.trim(), code: code.trim() });
      setBusy(false);
      if (res.ok) {
        setStep("done");
        return;
      }
      if (res.status === 423) {
        setError(t("authErrTooManyTries"));
      } else if (res.status === 401) {
        setError(t("authErrCodeInvalid"));
      } else {
        setError(res.error ?? t("authErrVerifyFailed"));
      }
    },
    [email, code],
  );

  useEffect(() => {
    const el = document.querySelector<HTMLInputElement>(step === "email" ? 'input[type="email"]' : 'input[name="code"]');
    el?.focus();
  }, [step]);

  if (step === "done") {
    return (
      <main class="wrap">
        <div class="card">
          <h1>{t("authDoneTitle")}</h1>
          <p class="tagline">{t("authDoneTagline")}</p>
        </div>
      </main>
    );
  }

  if (step === "code") {
    return <CodeStep email={email} code={code} error={error} busy={busy} remainingSec={remainingSec} cooldown={cooldown} onVerify={onVerify} onResend={onResend} setCode={setCode} setStep={setStep} setError={setError} />;
  }

  return <EmailStep email={email} error={error} busy={busy} accepted={accepted} remainingSec={remainingSec} cooldown={cooldown} onSendCode={onSendCode} setEmail={setEmail} setCode={setCode} setStep={setStep} setError={setError} setAccepted={setAccepted} />;
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
      <div class="card">
        <h1>{t("dataConsentTitle")}</h1>
        <p class="tagline">{t("dataConsentBody")}</p>
        <p class="notice">
          <a
            href={withExtensionUtm("https://emojery.app/privacy", {
              campaign: "auth_consent_links",
              content: "legacy_data_consent",
            })}
            target="_blank"
            rel="noopener noreferrer"
          >
            {t("authPrivacyLinkLabel")}
          </a>
        </p>
        <button
          class="primary"
          type="button"
          onClick={() => {
            document.title = t("authPageTitle");
            setAcknowledged(true);
          }}
        >
          {t("dataConsentContinueBtn")}
        </button>
      </div>
    </main>
  );
}

render(CONSENT_ONLY ? <ConsentGate /> : <App />, document.getElementById("app")!);
