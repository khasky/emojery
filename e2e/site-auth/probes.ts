// SPDX-License-Identifier: GPL-3.0-or-later
//
// Black-box probes executed *inside the page* by the bridge's `evaluate`, which
// runs them through `browser_run_code_unsafe` (the one MCP tool this bridge
// calls - see bridge.ts). They only read user-perceivable DOM - the shadow-hosted
// Emojery trigger/counter, mount anchors, hidden-native markers, and stray
// tooltips - exactly what a real user could see. No extension internals, no
// chrome.storage.
//
// The probes are JS *source strings* (they run in the browser, not in Node),
// composed with the shadow-piercing `dq` below (DQ_SRC). The harness wraps
// them with a sentinel + JSON.stringify (see bridge.ts) and parses the result;
// the Node-side helpers here read only that parsed evidence.

// Shadow-piercing deep query - `document.querySelector` does NOT cross the open
// shadow roots the trigger/picker live in.
export const DQ_SRC = `
const dq = (sel, root = document) => {
  const out = [], seen = new Set();
  const visit = (r) => {
    let l = []; try { l = [...r.querySelectorAll(sel)]; } catch {}
    for (const e of l) if (!seen.has(e)) { seen.add(e); out.push(e); }
    let a = []; try { a = [...r.querySelectorAll('*')]; } catch {}
    for (const e of a) if (e.shadowRoot) visit(e.shadowRoot);
  };
  visit(root); return out;
};
const triggerIn = (host) => {
  const root = host.shadowRoot || host;
  return root.querySelector('.khasky-emojery-trigger, .khasky-emojery-counter');
};
`;

interface HostInfo {
  visible: boolean;
  top: number;
  width: number;
  height: number;
  // Inside an open [role="dialog"] - FB renders a DIRECT permalink load as the
  // profile page with the post in a dialog on top, so the dialog is the surface
  // that actually holds the post (the page behind it keeps its own feed hosts).
  inDialog: boolean;
  label: string | null; // trigger aria-label (e.g. "1 reactions — ...")
  isCounter: boolean; // true when the trigger has reacted (shows a count)
  text: string; // trigger visible text (e.g. "🔥1")
}

export interface MountEvidence {
  url: string;
  hostCount: number;
  visibleHostCount: number; // visible `.khasky-emojery-host` - the gate for "trigger present"
  // Keys come from the `[data-khasky-emojery-mounted]` anchors directly: the host can be
  // moved away from its keyed anchor (e.g. GitHub places the picker in a
  // different <li> than the keyed one), so per-host key resolution is
  // unreliable. Anchors are the source of truth for identity/dedupe.
  mountKeys: string[];
  siteKeyCount: number; // mount keys matching the site prefix
  duplicateKeys: string[]; // a key on >1 connected anchor (invariant violation)
  // Posts carrying more than one picker (anchors grouped by their CLOSEST
  // [role="article"]). Complements duplicateKeys: two pickers on ONE post can
  // carry two DIFFERENT keys - e.g. the page-admin "View insights / Boost post"
  // row mounting a second host that steals the post's canonical photo key while
  // the real action row re-keys onto the CFT fallback - which the same-key
  // check cannot see. Invariant: 0.
  multiAnchorPostCount: number;
  roleTooltipCount: number; // stray [role="tooltip"] (FB date-hover artifact)
  hiddenNativeCount: number; // [data-khasky-emojery-hidden="1"]
  hosts: HostInfo[];
}

export function evidenceProbe(mountKeyPattern: string): string {
  return `${DQ_SRC}
const re = new RegExp(${JSON.stringify(mountKeyPattern)});
const hosts = dq('.khasky-emojery-host');
const info = hosts.map((h) => {
  const r = h.getBoundingClientRect();
  const t = triggerIn(h);
  const label = t && t.getAttribute ? (t.getAttribute('aria-label') || null) : null;
  const text = t ? (t.textContent || '').replace(/\\s+/g, ' ').trim() : '';
  const isCounter = !!(t && t.classList && t.classList.contains('khasky-emojery-counter'));
  return {
    visible: r.width > 0 && r.height > 0,
    top: Math.round(r.top),
    width: Math.round(r.width),
    height: Math.round(r.height),
    inDialog: !!(h.closest && h.closest('[role="dialog"], [role="alertdialog"]')),
    label, isCounter, text,
  };
});
const visible = info.filter((x) => x.visible);
const anchors = dq('[data-khasky-emojery-mounted]').filter((a) => a.isConnected);
const keys = anchors.map((a) => a.getAttribute('data-khasky-emojery-mounted')).filter(Boolean);
const keyCount = {};
for (const k of keys) keyCount[k] = (keyCount[k] || 0) + 1;
const duplicateKeys = Object.keys(keyCount).filter((k) => keyCount[k] > 1);
// Group anchors by their closest article so a quoted/nested post counts as its
// own group; anchors outside any article (photo/reel viewers) are skipped.
const perArticle = new Map();
for (const a of anchors) {
  const art = a.closest && a.closest('[role="article"]');
  if (art) perArticle.set(art, (perArticle.get(art) || 0) + 1);
}
const multiAnchorPostCount = [...perArticle.values()].filter((n) => n > 1).length;
return {
  url: location.href,
  hostCount: info.length,
  visibleHostCount: visible.length,
  mountKeys: keys,
  siteKeyCount: keys.filter((k) => re.test(k)).length,
  duplicateKeys,
  multiAnchorPostCount,
  roleTooltipCount: dq('[role="tooltip"]').filter((e) => e.getBoundingClientRect().width > 0).length,
  hiddenNativeCount: dq('[data-khasky-emojery-hidden="1"]').length,
  hosts: info,
};`;
}

// The surface that actually holds a permalink's post and its comment area. FB
// renders a DIRECT permalink load as the profile page with the post in a dialog
// on top (verified live on the default zuck post), and the profile feed behind
// the dialog legitimately mounts its own pickers - so single-picker contracts
// apply to the dialog's hosts when one is open, else to every visible host.
export function postSurfaceHosts(evidence: MountEvidence): HostInfo[] {
  const visible = evidence.hosts.filter((h) => h.visible);
  const dialogHosts = visible.filter((h) => h.inDialog);
  return dialogHosts.length > 0 ? dialogHosts : visible;
}

export interface PickerState {
  gridVisible: boolean; // emoji grid shown - extension is signed in
  // Unauthed. The extension ships no in-picker "sign in" marker to read, so this
  // has exactly one source: harness.openPickerState sets it when the trigger
  // click spawned an auth.html tab (which it then closes).
  authTabHint: boolean;
}

// Read whether the picker overlay shows the emoji grid (i.e. the extension is
// signed in). Run AFTER clicking a trigger.
export function pickerStateProbe(): string {
  return `${DQ_SRC}
const grid = dq('.khasky-emojery-grid-item').filter((e) => e.getBoundingClientRect().width > 0);
return { gridVisible: grid.length > 0, authTabHint: false };`;
}

// Whether the CLOSED trigger still carries the user's own reaction. `mine`
// arrives with the counts fetch, so this read - unlike a glance at a freshly
// opened grid - only turns false once the clear actually landed.
export function ownReactionProbe(): string {
  return `${DQ_SRC}
const t = dq('.khasky-emojery-host')
  .filter((h) => { const r = h.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
  .map(triggerIn)
  .find(Boolean);
return !!t && t.getAttribute('data-active') === 'true';`;
}

export interface SelectedReaction {
  hasSelection: boolean; // the signed-in user's own pick is highlighted
  selectedLabel: string | null;
}

// Whether the *open* picker shows the current user's own selected reaction -
// the black-box proof that a reaction persisted (e.g. after a reload).
export function selectedReactionProbe(): string {
  return `${DQ_SRC}
const sel = dq('.khasky-emojery-grid-item[aria-pressed="true"], [data-mine="true"], .khasky-emojery-breakdown-row[data-selected="true"]')
  .filter((e) => e.getBoundingClientRect().width > 0);
const first = sel[0];
return {
  hasSelection: sel.length > 0,
  selectedLabel: first ? (first.getAttribute('aria-label') || (first.textContent || '').trim() || null) : null,
};`;
}
