// SPDX-License-Identifier: GPL-3.0-or-later
import { h, render } from "preact";
import type { PickerInsertionPoint, SiteAdapter } from "../shared/adapter";
import { AUTH_KEY } from "../shared/auth-session";
import { HIDDEN_SELECTOR, HOST_CLASS, LAYOUT_ATTR, PLACEMENT_ATTR } from "../shared/dom";
import { ensureEnLoaded } from "../shared/emoji-meta";
import type { VoteBroadcast } from "../shared/messages";
import { markCoachSeen } from "../shared/onboarding";
import { DEFAULT_SETTINGS, type Settings, type TargetKey, targetKey } from "../shared/storage";
import { setThemePreference } from "../shared/theme";
import { maybePlayPublicReactionIntro, playButtonPlacement } from "./animations";
import { maybeShowCoachMark } from "./coach-mark";
import { logContentError } from "./debug";
import { consumeReactHint } from "./deep-link";
import { applyEmojiSpriteHost, preloadEmojiSprite } from "./emoji-sprite";
import { authStatus, sendMessage } from "./messaging";
import { cancelPendingMount, isNearPrefetchMargin, observePendingAnchor, pendingMountPoint, reobservePendingAnchor, setPendingAnchorHandler, setPendingMount } from "./mount-anchors";
import { hydrateDeferredCounts, loadInitial, primeCachedCounts, refreshTarget } from "./mount-counts";
import { isFallbackPlacement, placementModeChanged, resolveResponsivePlacement } from "./mount-placement";
import {
  authRefreshEntries,
  claimMountAnchor,
  clearAdjacentMountNodes,
  clearStaleAnchorMount,
  destroyMount,
  forEachMountedHost,
  hostElementOfMount,
  isCurrentMountPoint,
  mountedNode,
  pruneDisconnected,
  reconcileScanMounts,
  registerMountNode,
  reuseMountNode,
  setRefreshCallback,
  subscribeMount,
  teardownAllMounts,
  trackHostTimer,
  wrapHost,
  wrapperSpecChanged,
} from "./mount-registry";
import { detectRouteChange, markFirstPlacement, recordShownTarget, shownTargetCount } from "./mount-session";
import { appendPickerStyles, getOverlayRoot } from "./mount-shadow";
import { applyActionLayout, applyHostRowHeight, applyHostSpacing, applyPageTypography, applySiteButtonStyle, hostShapeSignature, readPageTypography, readSiteButtonStyle, reapplyHostShape, revealHost } from "./mount-style";
import { compactNativeCountsOnOverflow, restoreCompactedCounts } from "./native-compact";
import { hideNativeForReplace, restoreHiddenNatives } from "./native-replace";
import { startFbPrewarm, stopFbPrewarm } from "./native-trigger";
import { Picker } from "./picker";
import { setRingAnimation } from "./ring-spin";
import { invalidateContentSettings, readContentSettings } from "./settings-cache";
import { registerThemedHost } from "./themed-hosts";
import { createOnPick } from "./vote-client";

// An auth change refreshes every mounted target in every tab; unbounded, one
// sign-in with a few open feed tabs burst hundreds of count reads at once.
const AUTH_REFRESH_CONCURRENCY = 4;

let authListenerInstalled = false;
function installAuthChangeListener(): void {
  if (authListenerInstalled) return;
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  authListenerInstalled = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (!(AUTH_KEY in changes)) return;
    pruneDisconnected();
    void (async () => {
      const { authed: nowAuthed } = await authStatus();
      const queue = authRefreshEntries().values();
      // One shared iterator, four workers - each entry is taken by exactly one.
      await Promise.all(
        Array.from({ length: AUTH_REFRESH_CONCURRENCY }, async () => {
          for (const { cb, target } of queue) {
            await refreshTarget(cb, target, nowAuthed).catch((error: unknown) => logContentError("authChange.refreshTarget", error));
          }
        }),
      );
    })();
  });
}

// Nothing awaits a mount or a deferred hydration - a scan fires one per point and moves on.
// Absorbed rather than surfaced: the host page's console is not ours to write to. Traced
// through logContentError, which folds to nothing in a shipped build (ui/debug.ts) - so a
// dev or staging build shows the failure while a production one stays as quiet as before.
function runDetached(scope: string, work: Promise<unknown>): void {
  void work.catch((error: unknown) => logContentError(scope, error));
}

export function mountAll(points: PickerInsertionPoint[]): void {
  const routeChanged = detectRouteChange();
  reconcileScanMounts(points, { removeConnectedStale: routeChanged });
  // The badge counts pickers that have become visible on this route - a running
  // total that only grows (see shownTargetCount). Re-announce it on every scan so
  // an SPA route change (which reset it to zero) clears the stale count.
  announceInjectedCount(shownTargetCount());
  // One counts-cache read for the whole scan; each mount below reads its entry
  // out of it instead of issuing its own.
  primeCachedCounts(points.map((point) => point.target));
  for (const point of points) runDetached("mountAt", mountAt(point));
}

export function unmountAll(): void {
  teardownAllMounts();
  restoreHiddenNatives();
  restoreCompactedCounts();
}

// The fields this watcher compares (enabled, sites, theme, replaceNative,
// reactionAnimations), resolved from a raw storage.onChanged old/new snapshot the
// way getSettings resolves them. Not getSettings' whole merge: `emojiSentiment`
// comes through verbatim here, without its per-key default fallback.
function resolveSettingsSnapshot(raw: unknown): Settings {
  const stored = (raw ?? {}) as Partial<Settings>;
  return { ...DEFAULT_SETTINGS, ...stored, sites: { ...DEFAULT_SETTINGS.sites, ...(stored.sites ?? {}) } };
}

let settingsWatcherInstalled = false;
export function watchSettings(adapter: SiteAdapter): void {
  if (settingsWatcherInstalled) return;
  if (typeof chrome === "undefined" || !chrome.storage?.onChanged) return;
  settingsWatcherInstalled = true;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync" || !("settings" in changes)) return;
    invalidateContentSettings();
    const prev = resolveSettingsSnapshot(changes.settings.oldValue);
    const next = resolveSettingsSnapshot(changes.settings.newValue);
    // Ahead of the enable/site gates: the watcher re-stamps every mounted host through
    // shared/theme, and that has to happen even on a site whose mounts are switched off.
    setThemePreference(next.theme);
    const wasOn = prev.enabled && prev.sites[adapter.site] !== false;
    const isOn = next.enabled && next.sites[adapter.site] !== false;
    if (wasOn !== isOn) {
      if (isOn) mountAll(adapter.scan(document));
      else unmountAll();
      return;
    }
    if (!isOn) return;
    if (prev.replaceNative !== next.replaceNative) {
      if (!next.replaceNative) restoreHiddenNatives();
      // Re-scan so the mount reuse path re-asserts the native hide (when on)
      // and re-checks count compaction against the row's new width.
      mountAll(adapter.scan(document));
    }
    if (prev.reactionAnimations !== next.reactionAnimations) {
      // The RGB ring's spin is pure CSS gated on a host attribute (picker.css), so re-applying
      // it live restyles every mounted trigger without a remount.
      forEachMountedHost((host) => setRingAnimation(host, next.reactionAnimations));
    }
  });
}

export async function mountAt(rawPoint: PickerInsertionPoint): Promise<void> {
  const point = resolveResponsivePlacement(rawPoint);
  const key = targetKey(point.target);
  clearStaleAnchorMount(point, key);
  const mounted = mountedNode(key);
  if (tryReuseMount(mounted, point, key)) return;
  await schedulePendingMount(point, key);
}

// The reuse branch of mountAt: a live mount whose placement mode + wrapper still match is moved
// and re-asserted in place (true); a mismatched or disconnected one is torn down (false).
function tryReuseMount(mounted: Node | undefined, point: PickerInsertionPoint, key: TargetKey): boolean {
  if (mounted?.isConnected && !placementModeChanged(mounted, point) && !wrapperSpecChanged(mounted, point)) {
    reuseMountNode(mounted, point, key);
    // The same host is reused when a target moves between surfaces that share a
    // key (Facebook `/watch/?v=<id>` <-> `/reel/<id>`). If the new placement's
    // trigger form differs (horizontal row <-> vertical icon-column), re-blend so
    // the moved trigger takes the new form instead of keeping the first one.
    reblendMovedHostIfFormChanged(mounted, point);
    // A site re-render can rebuild the native after doMount hid it (reel feeds
    // recreate their action rails on scroll), leaving the original button visible
    // next to the trigger. Re-assert against the elements the CURRENT scan
    // resolved; both operations are idempotent.
    void reassertNativeState(mounted, point);
    return true;
  }
  // Either the placement crossed between primary and fallback / the surface's binding now
  // declares a different wrapper (SPA route: X status row <-> its narrower photo-view row),
  // or the site detached the node itself. Both tear down the same way: the wrapper and
  // spacing are rebuilt for the new context, and the old picker gets unmounted rather than
  // left subscribed.
  if (mounted) destroyMount(key, mounted);
  return false;
}

// Give up the deferral and mount: the entry must leave `pendingMounts` through
// cancelPendingMount, or its anchor stays observed for the life of the tab.
function mountNow(key: TargetKey, point: PickerInsertionPoint): void {
  cancelPendingMount(key);
  runDetached("doMount", doMount(point));
}

// Fired by the shared pending-anchor observer (mount-anchors).
function onPendingAnchorVisible(key: TargetKey): void {
  const point = pendingMountPoint(key);
  if (!point) return;
  mountNow(key, point);
}

setPendingAnchorHandler(onPendingAnchorVisible);

// The pending branch of mountAt: defers doMount until the anchor nears the viewport; dropped
// when settings disable the site.
async function schedulePendingMount(point: PickerInsertionPoint, key: TargetKey): Promise<void> {
  if (pendingMountPoint(key)) {
    claimMountAnchor(point.anchor, key);
    setPendingMount(key, point);
    if (point.mountImmediately || shouldMountNow(point.anchor)) {
      mountNow(key, point);
      return;
    }
    reobservePendingAnchor(key, point.anchor);
    return;
  }

  clearAdjacentMountNodes(point);
  claimMountAnchor(point.anchor, key);
  setPendingMount(key, point);

  const settings = await readContentSettings();
  if (!settings.enabled || !settings.sites[point.target.site]) {
    cancelPendingMount(key);
    return;
  }
  // Earliest point the ~1 MB sheet is known to be needed, and still ahead of the paint - this
  // mount is usually still waiting on its IntersectionObserver. Same timing for the lazy EN
  // label map the trigger's aria-label reads.
  preloadEmojiSprite();
  void ensureEnLoaded();

  const activePoint = pendingMountPoint(key);
  if (!activePoint) return;

  if (activePoint.mountImmediately || shouldMountNow(activePoint.anchor)) {
    mountNow(key, activePoint);
    return;
  }

  observePendingAnchor(key, activePoint.anchor);
}

// Re-apply the native-side effects of a mount (hide-for-replace, overflow
// count compaction) for a host that is being REUSED by a fresh scan. The scan's
// point references the live native elements - which the site may have recreated
// since doMount hid/compacted their predecessors.
async function reassertNativeState(mounted: Node, point: PickerInsertionPoint): Promise<void> {
  const settings = await readContentSettings().catch((error: unknown) => {
    logContentError("reassertNativeState.readSettings", error);
    return null;
  });
  if (!settings?.enabled || !settings.sites[point.target.site]) return;
  if (settings.replaceNative) hideNativeForReplace(point);
  const host = hostElementOfMount(mounted);
  if (host?.isConnected) compactNativeCountsOnOverflow(host, point);
}

function shouldMountNow(el: HTMLElement): boolean {
  if (isNearPrefetchMargin(el)) return true;
  // A replace-hidden anchor has a zero rect, so neither the margin probe nor the observer
  // can ever fire: mount it now.
  return el.isConnected && el.closest(HIDDEN_SELECTOR) !== null;
}

// Create the trigger host and apply the styling that does NOT depend on settings;
// the settings-dependent styling stays in doMount - nothing may cross that await.
function createHost(point: PickerInsertionPoint): { host: HTMLElement; typography: ReturnType<typeof readPageTypography> } {
  const host = document.createElement("span");
  host.className = HOST_CLASS;
  host.setAttribute(PLACEMENT_ATTR, isFallbackPlacement(point) ? "fallback" : "primary");
  host.style.display = "inline-block";
  host.style.alignSelf = "center";
  const typography = readPageTypography(point);
  applyPageTypography(host, typography);
  applySiteButtonStyle(host, readSiteButtonStyle(point));
  registerThemedHost(host);
  applyEmojiSpriteHost(host);
  return { host, typography };
}

// Wrap, insert at the placement, and spacing-correct the host in one synchronous
// pass - no await between clearing stale nodes, sampling margins, and inserting.
function insertAndSpace(host: HTMLElement, point: PickerInsertionPoint, key: TargetKey): void {
  const insertNode = wrapHost(host, point.wrapper);
  clearAdjacentMountNodes(point);
  // Sample the row's native spacing AFTER stale mount nodes are cleared (they
  // sit in the slot we are about to take and would skew the flank margins) and
  // BEFORE inserting - the only moment sibling-dependent site margins are
  // guaranteed intact.
  applyHostSpacing(host, point);

  switch (point.position) {
    case "before":
      point.anchor.parentNode?.insertBefore(insertNode, point.anchor);
      break;
    case "after":
      point.anchor.parentNode?.insertBefore(insertNode, point.anchor.nextSibling);
      break;
    case "append":
      point.anchor.appendChild(insertNode);
      break;
  }
  registerMountNode(key, insertNode);
  // Second pass, same task (no frame in between), so a structural site margin un-matched by the
  // insert is compensated before the first paint. Reuses the first pass's probe baseline - a
  // fresh probe would detach and re-attach the host for nothing.
  applyHostSpacing(host, point, { reuseProbe: true });
  // With the trigger now taking row space, a tight card can overflow - shorten
  // the native like count ("327 555" -> "327K") rather than shift any control.
  compactNativeCountsOnOverflow(host, point);
}

// Renders the Picker into a fresh shadow root, then kicks off the post-render style reblend /
// animations / deferred hydration. Owns the mount's last two awaits (auth status, initial
// counts).
async function renderPicker(host: HTMLElement, point: PickerInsertionPoint, key: TargetKey, settings: Settings, typography: ReturnType<typeof readPageTypography>): Promise<void> {
  const shadow = host.attachShadow({ mode: "open" });
  appendPickerStyles(shadow);

  const initialAuth = await authStatus();

  const initial = await loadInitial(point, initialAuth);

  let updateFromBroadcast: ((b: VoteBroadcast) => void) | null = null;

  const onPick = createOnPick({ point, settings });

  subscribeMount(key, point.target, (b) => {
    updateFromBroadcast?.(b);
  });
  installAuthChangeListener();

  const onSignIn = (): void => {
    void sendMessage({ type: "auth:openTab" }).catch((error: unknown) => logContentError("openAuthTab", error));
  };

  // /react deep-link (emojery.app/react -> target#emojery-react): consumed after every
  // early-return guard, so a bailed mount can't swallow the one-shot hint.
  const autoOpen = consumeReactHint(key);

  // A deep-linked picker opening by itself already teaches the trigger, so it
  // spends the one-shot coach-mark instead of stacking a tooltip under an
  // opening popover.
  if (autoOpen) void markCoachSeen().catch((error: unknown) => logContentError("markCoachSeen", error));

  render(
    h(Picker, {
      initial: { ...initial, isAuthed: initialAuth.authed },
      typography,
      onPick,
      onSignIn,
      autoOpen,
      // Prewarm FB's reactions flyout while the picker is open, so an exact
      // emoji match presses its reaction instantly (no-op on other sites and
      // while the auto-press setting is off).
      onOpenChange: (open: boolean) => {
        if (open) startFbPrewarm(point);
        else stopFbPrewarm(point);
      },
      // A function, not the node, so a detached overlay host can't strand the
      // popover - see the portalRoot prop's JSDoc.
      portalRoot: () => getOverlayRoot(),
      bindBroadcast: (cb) => {
        updateFromBroadcast = cb;
      },
      bindRefresh: (cb) => {
        setRefreshCallback(key, cb);
      },
    }),
    shadow,
  );

  scheduleStyleReblend(host, point);

  // After render, so the trigger button exists in the shadow to point at.
  if (!autoOpen) void maybeShowCoachMark(host).catch((error: unknown) => logContentError("maybeShowCoachMark", error));

  recordShownTarget(key);
  announceInjectedCount(shownTargetCount());
  if (settings.reactionAnimations) {
    if (markFirstPlacement(key)) playButtonPlacement(host);
    maybePlayPublicReactionIntro(initial.value);
  }
  if (initial.isLoading) {
    runDetached("hydrateDeferredCounts", hydrateDeferredCounts(point, key, initial.myReaction, initialAuth.authed, settings.reactionAnimations));
  }
}

async function doMount(point: PickerInsertionPoint): Promise<void> {
  const key = targetKey(point.target);
  if (!isCurrentMountPoint(point, key)) return;
  const { host, typography } = createHost(point);

  const settings = await readContentSettings();
  if (!isCurrentMountPoint(point, key)) return;

  // The RGB ring's spin follows the Reaction animations setting (same on/off switch as the
  // button-drop / intro below); the OS reduced-motion gate is applied separately, in
  // picker.css. The gradient border renders either way; only the spin is gated. The settings
  // watcher re-applies this live, and the registry parks the spin while the host is off screen.
  if (settings.reactionAnimations) setRingAnimation(host, true);

  applyHostRowHeight(host, point);

  applyActionLayout(host, point);

  if (settings.replaceNative) hideNativeForReplace(point);

  insertAndSpace(host, point, key);

  await renderPicker(host, point, key, settings, typography);
}

// Absolute ms from mount: sites hydrate their action rows at very different times
// (Reddit a beat late, YouTube's watch row past two seconds), so the schedule spreads.
const STYLE_REBLEND_DELAYS_MS = [150, 500, 1200, 2400];
// Consecutive passes that must change nothing before the schedule stops early. Two, not
// one: a row can measure its glyph a tick before its buttons get their real radius, and
// a single quiet pass would call that settled and strand the first look.
const STYLE_REBLEND_SETTLED_PASSES = 2;
// A host held hidden for its first glyph measure (SIZING_ATTR) is force-revealed here even
// if the icon never became measurable - em-fallback sizing beats an invisible button.
const SIZING_REVEAL_DEADLINE_MS = 1200;
// Re-measure past the delays above while the trigger still wears a stand-in size (see
// applyHostRowHeight): one measurement per tick, only for a host that never read its row's own
// icon - a settled one stops after the first tick.
const GLYPH_REMEASURE_EVERY_MS = 800;
const GLYPH_REMEASURE_UNTIL_MS = 10_000;

function scheduleStyleReblend(host: HTMLElement, point: PickerInsertionPoint): void {
  // Tracked per host so removeMountNode cancels them: a feed that mounts and
  // recycles 30 cards used to keep 150 live timers, each forcing layout on an
  // already-detached (or soon-detached) host.
  scheduleReblendStep(host, point, 0, hostShapeSignature(host), 0);
  trackHostTimer(
    host,
    window.setTimeout(() => {
      if (host.isConnected) revealHost(host);
    }, SIZING_REVEAL_DEADLINE_MS),
  );
  remeasureGlyphUntilFinal(host, point, Date.now() + GLYPH_REMEASURE_UNTIL_MS);
}

// One tick armed at a time rather than the whole schedule up front: what it bounds is the work
// PER TRIGGER, which is what a feed multiplies - a row already settled at mount stops after the
// second pass instead of re-reading the surrounding controls four times. e2e/perf.spec.ts holds
// the budget that keeps it from growing.
function scheduleReblendStep(host: HTMLElement, point: PickerInsertionPoint, index: number, lastSignature: string, quietPasses: number): void {
  const at = STYLE_REBLEND_DELAYS_MS[index];
  if (at === undefined) return;
  trackHostTimer(
    host,
    window.setTimeout(
      () => {
        if (!host.isConnected) return;
        // A card the user has already scrolled past keeps whatever doMount stamped -
        // a complete blend, this schedule only refines it - so there is nothing to
        // show for re-reading its row. Not counted as a quiet pass: scrolling back
        // inside the window resumes the schedule where it left off.
        if (!isNearPrefetchMargin(host)) {
          scheduleReblendStep(host, point, index + 1, lastSignature, quietPasses);
          return;
        }
        const glyphFinal = reapplyHostShape(host, point);
        // Counts hydrate late on some sites - the row can start fitting and
        // overflow only once the full number renders, so re-check here too.
        compactNativeCountsOnOverflow(host, point);
        const signature = hostShapeSignature(host);
        const quiet = signature === lastSignature ? quietPasses + 1 : 0;
        // A stand-in glyph is never settled, however quiet the pass was: the row that
        // hydrates its icon past this schedule is exactly the one the later ticks exist for.
        if (glyphFinal && quiet >= STYLE_REBLEND_SETTLED_PASSES) return;
        scheduleReblendStep(host, point, index + 1, signature, quiet);
      },
      at - (STYLE_REBLEND_DELAYS_MS[index - 1] ?? 0),
    ),
  );
}

// Self-rescheduling rather than an interval, so the chain simply stops on the tick that
// reads the row's own icon (or when the host goes away / the window closes).
function remeasureGlyphUntilFinal(host: HTMLElement, point: PickerInsertionPoint, deadline: number): void {
  trackHostTimer(
    host,
    window.setTimeout(() => {
      if (!host.isConnected || applyHostRowHeight(host, point) || Date.now() >= deadline) return;
      remeasureGlyphUntilFinal(host, point, deadline);
    }, GLYPH_REMEASURE_EVERY_MS),
  );
}

function announceInjectedCount(targetCount: number): void {
  void sendMessage({ type: "ui:injected", targetCount }).catch((error: unknown) => logContentError("announceInjectedCount", error));
}

// Re-blend a moved host only when its trigger form (horizontal row vs vertical
// icon-column) no longer matches the new placement - cheap on ordinary re-scans
// (nothing changed), and switches the form on a genuine surface move.
function reblendMovedHostIfFormChanged(mounted: Node, point: PickerInsertionPoint): void {
  const host = hostElementOfMount(mounted);
  if (!host) return;
  const wantIconColumn = point.triggerLayout === "icon-column";
  const hasIconColumn = host.getAttribute(LAYOUT_ATTR) === "icon-column";
  if (wantIconColumn === hasIconColumn) return;
  reapplyHostShape(host, point);
}
