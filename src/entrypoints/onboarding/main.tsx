// SPDX-License-Identifier: GPL-3.0-or-later
//
// Post-install onboarding page (background/install.ts opens it once, on
// `onInstalled` with reason "install"). A checklist that ticks ITSELF: every
// step is a state the extension can already observe, so nothing here asks the
// user to confirm anything - and the last tick sets off the confetti.

import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../shared/i18n";
import { hasReactedOnce, hasSeenTrigger, watchOnboardingFlags } from "../../shared/onboarding";
import { bootstrapPage } from "../../shared/page-bootstrap";
import { SUPPORTED_SITES } from "../../shared/sites";
import { TRY_IT_LIVE_URL, withExtensionUtm } from "../../shared/tracking-links";
import { getToolbarUserSettings } from "../../shared/webext";

// The pin step re-checks on this cadence for as long as the page is open. No
// event exists for pin/unpin, and the poll cannot stop at the first `true`:
// unpinning right after pinning would leave a stale "Pinned!" until a reload.
const PIN_POLL_MS = 1000;

// How long the burst stays in the DOM; the CSS animation is shorter.
const CONFETTI_MS = 2600;
const CONFETTI_PIECES = 30;
const CONFETTI_COLORS = ["#1877f2", "#fec206", "#ef4444", "#22c55e", "#a855f7", "#06b6d4"];
// Burst geometry: pieces fly out to a base distance plus a per-piece step, so a ring of
// them lands at a few different radii instead of one perfect circle.
const CONFETTI_BASE_PX = 180;
const CONFETTI_RADIUS_STRIDE_PX = 55;
const CONFETTI_RADIUS_GROUPS = 5;
// Same trick for spin and start time, on different cycle lengths so no two pieces share
// all three.
const CONFETTI_SPIN_GROUPS = 7;
const CONFETTI_SPIN_STEP_DEG = 90;
const CONFETTI_DELAY_GROUPS = 6;
const CONFETTI_DELAY_STEP_MS = 60;

bootstrapPage(t("onboardingTitle"), true);

// `null` = pin state unknowable (no getUserSettings on this engine): the step is
// dropped from the checklist rather than left permanently unticked. Otherwise it
// tracks the toolbar for as long as the page is open - pinning and unpinning
// both land, in either order.
function usePinnedState(): boolean | null {
  const [pinned, setPinned] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const again = () => {
      timer = window.setTimeout(() => void check(), PIN_POLL_MS);
    };
    const check = async (): Promise<void> => {
      // A backgrounded tab is not being looked at: skip the read, keep the loop.
      if (document.visibilityState === "hidden") {
        again();
        return;
      }
      const settings = await getToolbarUserSettings();
      if (cancelled) return;
      // No answer means no such API here - leave the step out rather than
      // claiming either value, and stop asking.
      if (typeof settings?.isOnToolbar !== "boolean") return;
      setPinned(settings.isOnToolbar);
      again();
    };
    void check();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, []);
  return pinned;
}

// The two latches the content script and the vote queue write. Event-driven:
// storage.onChanged fires in this page even while its tab sits in the
// background, which is exactly where these two get satisfied.
function useOnboardingFlags(): { sawTrigger: boolean; reacted: boolean } {
  const [flags, setFlags] = useState({ sawTrigger: false, reacted: false });
  useEffect(() => {
    let cancelled = false;
    const read = async (): Promise<void> => {
      const [sawTrigger, reacted] = await Promise.all([hasSeenTrigger(), hasReactedOnce()]);
      if (!cancelled) setFlags({ sawTrigger, reacted });
    };
    void read();
    const unwatch = watchOnboardingFlags(() => void read());
    return () => {
      cancelled = true;
      unwatch();
    };
  }, []);
  return flags;
}

/**
 * Fires once, when the last step ticks. A checklist finished while the tab was
 * in the background would burst into an empty room, so the confetti waits for
 * the user to come back instead of being spent unseen.
 */
function useCelebration(complete: boolean): boolean {
  const [firing, setFiring] = useState(false);
  const spent = useRef(false);

  useEffect(() => {
    if (!complete || spent.current) return;
    let timer: number | undefined;
    const fire = (): void => {
      if (spent.current) return;
      spent.current = true;
      setFiring(true);
      timer = window.setTimeout(() => setFiring(false), CONFETTI_MS);
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") fire();
    };
    if (document.visibilityState === "visible") fire();
    else document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [complete]);

  return firing;
}

// Index-derived angles and distances rather than Math.random: a burst that looks
// the same every time is easier to judge, and nothing here needs entropy.
const Confetti = () => (
  <div class="confetti" aria-hidden="true">
    {Array.from({ length: CONFETTI_PIECES }, (_, i) => {
      const angle = (i / CONFETTI_PIECES) * Math.PI * 2;
      const distance = CONFETTI_BASE_PX + (i % CONFETTI_RADIUS_GROUPS) * CONFETTI_RADIUS_STRIDE_PX;
      const style = {
        "--cx": `${Math.round(Math.cos(angle) * distance)}px`,
        "--cy": `${Math.round(Math.sin(angle) * distance)}px`,
        "--cr": `${(i % CONFETTI_SPIN_GROUPS) * CONFETTI_SPIN_STEP_DEG}deg`,
        background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
        animationDelay: `${(i % CONFETTI_DELAY_GROUPS) * CONFETTI_DELAY_STEP_MS}ms`,
      };
      return <span class="piece" key={i} style={style} />;
    })}
  </div>
);

interface Step {
  key: string;
  title: string;
  body?: string;
  doneBody?: string;
  done: boolean;
  detail?: preact.ComponentChildren;
}

export function App() {
  const pinned = usePinnedState();
  const { sawTrigger, reacted } = useOnboardingFlags();

  const steps: Step[] = [
    { key: "install", title: t("onboardingStepInstallTitle"), done: true },
    // Dropped entirely where the browser cannot report pin state - a step that
    // can never tick would strand the progress bar (and the confetti) forever.
    ...(pinned === null ? [] : [{ key: "pin", title: t("onboardingStepPinTitle"), body: t("onboardingStepPinBody"), doneBody: t("onboardingStepPinDone"), done: pinned }]),
    {
      key: "spot",
      title: t("onboardingStepSpotTitle"),
      body: t("onboardingStepSpotBody"),
      done: sawTrigger,
      detail: (
        <ul class="site-chips" aria-label={t("onboardingSitesHeading")}>
          {SUPPORTED_SITES.map((site) => (
            <li key={site.site}>{site.label}</li>
          ))}
        </ul>
      ),
    },
    { key: "react", title: t("onboardingStepReactTitle"), body: t("onboardingStepReactBody"), done: reacted },
  ];

  const done = steps.filter((step) => step.done).length;
  const complete = done === steps.length;
  const celebrating = useCelebration(complete);

  return (
    <main class="wrap">
      <div class="card">
        <section class="checklist" aria-label={t("onboardingTitle")}>
          <div class={complete ? "progress complete" : "progress"}>
            {/* The bar is decorative; the label beside it carries the same value as text. */}
            <span class="track" aria-hidden="true">
              <i style={{ width: `${(done / steps.length) * 100}%` }} />
            </span>
            <span class={complete ? "label complete" : "label"} aria-live="polite">
              {complete ? t("onboardingAllSet") : t("onboardingProgress", [String(done), String(steps.length)])}
            </span>
          </div>
          <ol class="steps">
            {steps.map((step) => (
              <li key={step.key} class={step.done ? "step done" : "step"}>
                <span class="tick" aria-hidden="true">
                  {step.done ? "✓" : ""}
                </span>
                <div>
                  <b>{step.title}</b>
                  {step.done && step.doneBody ? <span>{step.doneBody}</span> : step.body ? <span>{step.body}</span> : null}
                  {step.detail}
                </div>
              </li>
            ))}
          </ol>
        </section>

        <aside class="side">
          {/* The sparkles are pseudo-elements on this span: an <img> is a replaced
              element and carries none of its own (same trick as the popup header). */}
          <span class="mark">
            <img src="/icons/icon-128.png" alt="" aria-hidden="true" />
          </span>
          <div>
            <h1>{t("onboardingTitle")}</h1>
            <p class="tagline">{t("onboardingTagline")}</p>
          </div>
          {/* A new tab on purpose: this page is a live checklist, and following
              the link in place would throw away the very progress the visit is
              about to tick off. */}
          <a class="primary" href={TRY_IT_LIVE_URL} target="_blank" rel="noreferrer">
            {t("onboardingTryBtn")}
          </a>
          <a class="home" href={withExtensionUtm("https://emojery.app/", { campaign: "onboarding_page", content: "footer_link" })} target="_blank" rel="noreferrer">
            emojery.app
          </a>
        </aside>
      </div>
      {celebrating ? <Confetti /> : null}
    </main>
  );
}

const root = document.getElementById("app");
if (root) render(<App />, root);
