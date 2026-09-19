// SPDX-License-Identifier: GPL-3.0-or-later
//
// Auth page for the extension's provider sign-in flow.

import { type ComponentChild, Fragment, render } from "preact";
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { lastAccountPerProvider } from "../../shared/account-names";
import { type I18nKey, t } from "../../shared/i18n";
import type { RuntimeResponse, SignInRefusal } from "../../shared/messages";
import { type OidcProvider, providerAccountUrl, providerLabel, splitFeaturedProviders } from "../../shared/oidc-providers";
import { bootstrapPage } from "../../shared/page-bootstrap";
import { AGREE_CLASS, AUTH_ERROR_CLASS, AUTH_ERROR_ID, CARD_CLASS, COUNTDOWN_CLASS, LAST_ACCOUNT_CLASS, MORE_PROVIDERS_CLASS, OTHER_ACCOUNT_CLASS, PROVIDER_BUTTON_CLASS, PROVIDER_LIST_CLASS, SPINNER_CLASS, TAGLINE_CLASS } from "../../shared/page-dom";
import { noteTermsAccepted, termsAccepted } from "../../shared/terms-consent";
import { withExtensionUtm } from "../../shared/tracking-links";
import { sendRuntimeMessage } from "../../shared/webext";

// Fresh installs on pre-140 Firefox open this page with `?consent=1` (background/install.ts) to get
// the data-collection disclosure their browser is too old to show itself.
const CONSENT_ONLY = typeof location !== "undefined" && new URLSearchParams(location.search).get("consent") === "1";

bootstrapPage(CONSENT_ONLY ? t("dataConsentTitle") : t("authPageTitle"), true);

type Step = "provider" | "busy" | "done";

type SignedIn = Extract<RuntimeResponse, { type: "auth:signedIn" }>;

// The copy each named refusal gets. `client_outdated` is the one refusal whose
// fix is on the user's side (update from the store), so it gets its own line
// instead of the generic fallback.
const REFUSAL_COPY: Record<SignInRefusal, I18nKey> = {
  cancelled: "authErrCancelled",
  provider_denied: "authErrProviderDenied",
  enrollment_failed: "authErrEnrollFailed",
  client_outdated: "authErrOutdated",
  device_limit: "authErrDeviceLimit",
  unavailable: "authErrUnknown",
};

// The exchange itself runs in the service worker (background/message-router), not
// here: the identity window is opened from there, and whatever it comes back with
// belongs where it is used. An answer that is not the exchange's own envelope
// (the background's generic error, a dropped channel) reads as the generic refusal.
// No deadline: the answer waits on the provider's window (the user's own pace) and
// on a first sign-in's enrollment, both longer than the round-trip timeout allows;
// a background that dies still rejects through the closed channel.
async function askSignIn(provider: OidcProvider, chooser: boolean): Promise<SignedIn> {
  const message = chooser ? { type: "auth:signIn" as const, provider, chooser: true } : { type: "auth:signIn" as const, provider };
  const res = await sendRuntimeMessage(message, null).catch(() => undefined);
  return res?.type === "auth:signedIn" ? res : { type: "auth:signedIn", ok: false, refusal: "unavailable" };
}

async function askProviders(): Promise<{ providers: OidcProvider[]; chooser: OidcProvider[] } | null> {
  const res = await sendRuntimeMessage({ type: "auth:providers" }).catch(() => undefined);
  return res?.type === "auth:providers" ? { providers: res.providers, chooser: res.chooser } : null;
}

// Monochrome marks, one per known provider, drawn in `currentColor` so they follow
// the theme; a provider without one gets the generic key. Decorative: the button's
// text is its name.
const PROVIDER_MARKS: Record<string, ComponentChild> = {
  google: <path d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.9 1.5l2.6-2.5C16.8 3.1 14.6 2 12 2 6.5 2 2 6.5 2 12s4.5 10 10 10c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.7H12z" />,
  apple: (
    <path d="M16.4 12.7c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.3 1.2 9.7.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.2-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.2-1.2 3-2.4.9-1.4 1.3-2.7 1.3-2.8 0 0-2.6-1-2.6-3.8zM14 5.4c.7-.8 1.1-2 1-3.1-1 0-2.2.7-2.9 1.5-.6.7-1.2 1.9-1 3 1.1.1 2.2-.6 2.9-1.4z" />
  ),
  microsoft: <path d="M3 3h8.5v8.5H3zm9.5 0H21v8.5h-8.5zM3 12.5h8.5V21H3zm9.5 0H21V21h-8.5z" />,
  facebook: <path d="M13.5 22v-8h2.7l.4-3.2h-3.1V8.8c0-.9.3-1.6 1.6-1.6h1.7V4.4c-.3 0-1.3-.1-2.5-.1-2.5 0-4.1 1.5-4.1 4.2v2.3H7.4V14h2.8v8h3.3z" />,
  twitch: <path d="M4.3 2 2.5 6.4v14.9h5.1V24h2.8l2.6-2.7h4.1l5.4-5.4V2H4.3zm16.4 12.9-3.1 3.1h-5l-2.6 2.6v-2.6H5.9V3.8h14.8v11.1zM16.4 7.2h-1.8v5.4h1.8V7.2zm-4.9 0h-1.8v5.4h1.8V7.2z" />,
  slack: (
    <path d="M9.4 2.5a2 2 0 0 0 0 4.1h2V4.5a2 2 0 0 0-2-2zm0 5.4H4.1a2 2 0 1 0 0 4.1h5.3a2 2 0 1 0 0-4.1zm12.1 2a2 2 0 1 0-4.1 0v2h2a2 2 0 0 0 2.1-2zm-5.4 0V4.5a2 2 0 1 0-4.1 0v5.4a2 2 0 1 0 4.1 0zm-2 12.1a2 2 0 1 0 0-4.1h-2v2a2 2 0 0 0 2 2.1zm0-5.4h5.3a2 2 0 1 0 0-4.1h-5.3a2 2 0 1 0 0 4.1zm-12.1-2a2 2 0 1 0 4.1 0v-2h-2a2 2 0 0 0-2.1 2zm5.4 0v5.3a2 2 0 1 0 4.1 0v-5.3a2 2 0 1 0-4.1 0z" />
  ),
};
const GENERIC_MARK: ComponentChild = <path d="M14.5 2A7.5 7.5 0 0 0 7.3 11.7L2 17v5h5v-3h3v-3h3l1.4-1.4A7.5 7.5 0 1 0 14.5 2zm2 5a2 2 0 1 1 0 4 2 2 0 0 1 0-4z" />;

function ProviderMark({ provider }: { provider: OidcProvider }) {
  return (
    <svg class="provider-mark" viewBox="0 0 24 24" width="20" height="20" fill="currentColor" aria-hidden="true" focusable="false">
      {PROVIDER_MARKS[provider] ?? GENERIC_MARK}
    </svg>
  );
}

// Long enough to read "You're signed in" and see where the tab is going, short
// enough that the reaction waiting on the other tab is still what the user is
// thinking about. "Stay here" turns it off (WCAG), and "Back to the page"
// skips the wait entirely.
const RETURN_DELAY_SECONDS = 10;

/** The last step, on the same countdown either way: back to the page whose gate
 *  started the sign-in, or, when it started in the popup, just closed. A tab left
 *  behind on a finished sign-in is litter in both cases. */
function DoneStep({ returnsToPage }: { returnsToPage: boolean }) {
  const [remaining, setRemaining] = useState(RETURN_DELAY_SECONDS);
  const [counting, setCounting] = useState(true);
  const [returning, setReturning] = useState(returnsToPage);
  const backRef = useRef<HTMLButtonElement>(null);
  // A click landing on the same tick the countdown expires would otherwise ask
  // twice; the second ask finds the marker already spent and reads as a failure.
  const returnSent = useRef(false);

  const goBack = useCallback(async () => {
    if (returnSent.current) return;
    returnSent.current = true;
    const res = await sendRuntimeMessage({ type: returning ? "auth:returnToOrigin" : "auth:closeTab" }).catch(() => undefined);
    // On success the background closes this tab, so nothing below ever repaints.
    // On failure the origin tab went away mid-countdown, or the tab cannot be
    // closed from here - either way the step stops counting and keeps its copy.
    if (res?.type !== "ok") {
      setReturning(false);
      setCounting(false);
    }
  }, [returning]);

  useEffect(() => {
    if (!counting) return;
    if (remaining <= 0) {
      void goBack();
      return;
    }
    const id = setTimeout(() => setRemaining((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [counting, remaining, goBack]);

  // The primary action, focused as the step mounts: the provider buttons it
  // replaces have just been removed, which would otherwise drop focus to the body.
  useEffect(() => {
    backRef.current?.focus();
  }, []);

  if (!counting) {
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
          {t(returning ? "authDoneReturnTagline" : "authDoneCloseTagline")}
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
          {t(returning ? "authDoneReturnNowBtn" : "authDoneCloseNowBtn")}
        </button>
      </div>
    </main>
  );
}

/** The identity window is open: nothing to do here but say so, and wait. A first
 *  sign-in also builds the enrolment proof, which runs for tens of seconds after the
 *  provider window closes, so the wait is announced and the tab guards itself. */
function BusyStep({ provider }: { provider: OidcProvider }) {
  // Closing the tab mid-flight strands the sign-in: the code is spent, the account
  // key is not registered yet, and the next attempt starts over. The browser's own
  // leave-site prompt is the only one that can stop that, and it still lets the
  // impatient leave.
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Set for the browsers that still require it; none renders the string.
      e.returnValue = "";
    };
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, []);

  return (
    <main class="wrap">
      <div class={CARD_CLASS}>
        <h1>{t("authSignInTitle")}</h1>
        <p class={TAGLINE_CLASS} role="status">
          {t("authSigningInWith", providerLabel(provider))}
        </p>
        {/* The sentence above is what a screen reader announces; the ring is for the eye. */}
        <div class={SPINNER_CLASS} aria-hidden="true" />
        <p class="keep-open">{t("authSigningInKeepOpen")}</p>
      </div>
    </main>
  );
}

// The way to a second account at one provider. Most reopen their own picker on
// request, so the control starts the sign-in again and asks for it. Apple cannot:
// it takes no parameter for this, and the only way across is ending the session
// Apple holds - so there the control is a link to its account page, which says
// where it goes rather than restarting a flow that would return the same account.
function OtherAccount({ provider, canChoose, accepted, onPick }: { provider: OidcProvider; canChoose: boolean; accepted: boolean; onPick: (provider: OidcProvider, chooser: boolean) => void }) {
  const label = providerLabel(provider);
  if (canChoose) {
    return (
      <button class={`linkish ${OTHER_ACCOUNT_CLASS}`} type="button" data-provider={provider} disabled={!accepted} onClick={() => onPick(provider, true)}>
        {t("authOtherAccountBtn", label)}
      </button>
    );
  }
  const accountUrl = providerAccountUrl(provider);
  if (!accountUrl) return null;
  return (
    <a class={`linkish ${OTHER_ACCOUNT_CLASS}`} data-provider={provider} href={withExtensionUtm(accountUrl, { campaign: "auth_switch_account", content: provider })} target="_blank" rel="noopener noreferrer">
      {t("authSignOutAtProviderBtn", label)}
    </a>
  );
}

type ProviderStepProps = {
  providers: OidcProvider[] | null | undefined;
  /** Account name last used with each provider on this device, for the hint under
   *  its button. Empty until the store answers, and for a first sign-in. */
  lastAccounts: Record<string, string>;
  /** The providers that answer to a request for their account picker. The control
   *  appears for these only, so it never promises a switch that would not happen. */
  chooserProviders: OidcProvider[];
  error: string | null;
  accepted: boolean;
  showAll: boolean;
  onPick: (provider: OidcProvider, chooser: boolean) => void;
  onRetryProviders: () => void;
  onAccept: (value: boolean) => void;
  setShowAll: (value: boolean) => void;
};

// `providers` is undefined while the list loads, null when it could not be read
// (the API unreachable, the worker gone) - that state shows the generic error
// with a retry, since nothing else on the page can be done without the list.
function ProviderStep({ providers, lastAccounts, chooserProviders, error, accepted, showAll, onPick, onRetryProviders, onAccept, setShowAll }: ProviderStepProps) {
  const firstButton = useRef<HTMLButtonElement>(null);
  const firstRevealed = useRef<HTMLButtonElement>(null);
  const wasShowingAll = useRef(showAll);
  // Focus lands on the first choice once there is one; before that the page
  // has no field to land in.
  useEffect(() => {
    firstButton.current?.focus();
  }, [providers]);
  // The button that revealed the rest removes itself, so keyboard focus has to
  // move into what it opened rather than back to the top of the document.
  useEffect(() => {
    if (showAll && !wasShowingAll.current) firstRevealed.current?.focus();
    wasShowingAll.current = showAll;
  }, [showAll]);

  const { featured, rest } = splitFeaturedProviders(providers ?? []);
  const shown = showAll ? [...featured, ...rest] : featured;

  return (
    <main class="wrap">
      <div class={CARD_CLASS}>
        <h1>{t("authSignInTitle")}</h1>
        <p class={TAGLINE_CLASS}>{t("authSignInTagline")}</p>
        <label class={AGREE_CLASS}>
          <input type="checkbox" checked={accepted} onChange={(e: Event) => onAccept((e.target as HTMLInputElement).checked)} />
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
        {error ? (
          <div class={AUTH_ERROR_CLASS} id={AUTH_ERROR_ID} role="alert">
            {error}
          </div>
        ) : null}
        {providers === null ? (
          <button class="linkish" type="button" onClick={onRetryProviders}>
            {t("authRetryBtn")}
          </button>
        ) : (
          <div class={PROVIDER_LIST_CLASS} aria-describedby={error ? AUTH_ERROR_ID : undefined}>
            {shown.map((provider, index) => (
              <Fragment key={provider}>
                <button
                  class={PROVIDER_BUTTON_CLASS}
                  type="button"
                  data-provider={provider}
                  disabled={!accepted}
                  // One callback for both marks: with no featured provider on the list
                  // the first button is also the first revealed one, and two `ref` props
                  // on one element would leave whichever lost null.
                  ref={(el: HTMLButtonElement | null) => {
                    if (index === 0) firstButton.current = el;
                    if (index === featured.length) firstRevealed.current = el;
                  }}
                  onClick={() => onPick(provider, false)}
                >
                  <ProviderMark provider={provider} />
                  <span>
                    {t("authProviderBtn", providerLabel(provider))}
                    {/* Which account this device used here last: with the `openid` scope
                        alone the provider tells us nothing to show, and someone holding
                        two accounts at one provider needs the reminder before the click. */}
                    {lastAccounts[provider] ? <span class={LAST_ACCOUNT_CLASS}>{t("authLastAccount", lastAccounts[provider])}</span> : null}
                  </span>
                </button>
                {/* Only where there is something to switch AWAY from, and only where
                    the provider will actually offer a picker: signing out here ends
                    our session, never the one the browser holds with the provider,
                    so without this the second account is unreachable from the page. */}
                {lastAccounts[provider] ? <OtherAccount provider={provider} canChoose={chooserProviders.includes(provider)} accepted={accepted} onPick={onPick} /> : null}
              </Fragment>
            ))}
            {showAll || rest.length === 0 ? null : (
              <button class={`linkish ${MORE_PROVIDERS_CLASS}`} type="button" disabled={!accepted} onClick={() => setShowAll(true)}>
                {t("authMoreProvidersBtn")}
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}

function App() {
  const [step, setStep] = useState<Step>("provider");
  const [providers, setProviders] = useState<OidcProvider[] | null | undefined>(undefined);
  const [chooserProviders, setChooserProviders] = useState<OidcProvider[]>([]);
  const [lastAccounts, setLastAccounts] = useState<Record<string, string>>({});
  const [picked, setPicked] = useState<OidcProvider | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);
  // Held here, not in the step: a refused sign-in comes back to the list, and a
  // reader who already opened the longer list should not have to open it again.
  const [showAll, setShowAll] = useState(false);
  const [returnsToPage, setReturnsToPage] = useState(false);

  const loadProviders = useCallback(() => {
    setProviders(undefined);
    void askProviders().then((list) => {
      setProviders(list === null || list.providers.length === 0 ? null : list.providers);
      setChooserProviders(list?.chooser ?? []);
    });
  }, []);

  useEffect(loadProviders, [loadProviders]);

  // Device-local, so it never blocks the list: the hint appears when it appears.
  useEffect(() => {
    void lastAccountPerProvider()
      .then(setLastAccounts)
      .catch(() => {});
  }, []);

  // An agreement already given for the revision in force ticks the box back, so a
  // second sign-in does not ask twice for the same consent. Read once, on mount:
  // after that the reader owns the box.
  useEffect(() => {
    void termsAccepted().then((remembered) => {
      if (remembered) setAccepted(true);
    });
  }, []);

  // Remembered as it is ticked rather than at the sign-in, so the agreement is
  // recorded even when the reader closes the page without picking a provider.
  const onAccept = useCallback((value: boolean) => {
    setAccepted(value);
    void noteTermsAccepted(value);
  }, []);

  // The tab title follows the step: a tab strip full of pages still says which one
  // is done.
  useEffect(() => {
    document.title = t(step === "done" ? "authDonePageTitle" : "authPageTitle");
  }, [step]);

  // The busy step replaces the list, so a second pick cannot land while one runs.
  const pick = useCallback(async (provider: OidcProvider, chooser: boolean) => {
    setError(null);
    setPicked(provider);
    setStep("busy");
    const res = await askSignIn(provider, chooser);
    if (res.ok) {
      setReturnsToPage(res.returnsToPage === true);
      setStep("done");
      return;
    }
    setError(t(REFUSAL_COPY[res.refusal]));
    setStep("provider");
  }, []);

  if (step === "done") return <DoneStep returnsToPage={returnsToPage} />;
  if (step === "busy" && picked) return <BusyStep provider={picked} />;
  return <ProviderStep providers={providers} lastAccounts={lastAccounts} chooserProviders={chooserProviders} error={error} accepted={accepted} showAll={showAll} onPick={(provider, chooser) => void pick(provider, chooser)} onRetryProviders={loadProviders} onAccept={onAccept} setShowAll={setShowAll} />;
}

// Shown ahead of the sign-in form on browsers that never prompted for data collection themselves.
// Read-only: the only toggleable bucket is `technicalAndInteraction`, and pre-140 Firefox
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
