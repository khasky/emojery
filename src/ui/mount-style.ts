// SPDX-License-Identifier: GPL-3.0-or-later
//
// Visual blending for the inline trigger: read the host page's typography and the surface
// (border-radius / fill / text colour) of the action-row buttons around the injection point,
// and stamp them onto the picker host so the trigger reads as a sibling of the site's own
// controls. Reads the page, writes only onto our own host (plus the one same-task detach in
// probeNativeFlankMargins); no mount lifecycle state and no storage live here. What outlives a
// single host - the remembered surface, the per-site glyph canon - is mount-style-memory.ts;
// the two module-level caches below (spacingBaselines, revealedHosts) are host-keyed weak
// collections that die with their element.
import { elementsToArray, type PickerInsertionPoint } from "../shared/adapter";
import { HIDDEN_ATTR, HOST_CLASS, HOST_SELECTOR, LAYOUT_ATTR, PAGE_FONT_VAR } from "../shared/dom";
import { getCurrentTheme } from "../shared/theme";
import { BUTTON_DROP_CLASS } from "./animations";
import { composite, isSolidFill, parseRgba, type RgbaColor, rgbaToRgbString } from "./mount-color";
import { clampRadius, largestCornerPx, marginPx, normalizeReadableColor, pickRepresentativeRadius, readPaddingInline } from "./mount-style-math";
import { glyphPxOrRemembered, preferRememberedRadius, rememberedSiteStyle, rememberSiteStyle, type SiteButtonStyle } from "./mount-style-memory";
import type { PickerTypography } from "./picker";

export function readPageTypography(point: PickerInsertionPoint): PickerTypography {
  const refs = [...elementsToArray(point.nativeElement), point.anchor, point.anchor.parentElement].filter((el): el is HTMLElement => !!el);

  for (const ref of refs) {
    for (const child of Array.from(ref.querySelectorAll<HTMLElement>("button, a, span, div"))) {
      if (!child.textContent?.trim()) continue;
      const nested = readUsableTypography(child);
      if (nested) return nested;
    }

    const direct = readUsableTypography(ref);
    if (direct) return direct;
  }

  return {};
}

function readUsableTypography(el: HTMLElement): PickerTypography | null {
  if (!el.isConnected) return null;
  const cs = window.getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden") return null;
  const fontPx = Number.parseFloat(cs.fontSize);
  if (!Number.isFinite(fontPx) || fontPx <= 0) return null;

  const typography: PickerTypography = { fontSize: `${fontPx}px` };
  if (cs.fontFamily) typography.fontFamily = cs.fontFamily;
  return typography;
}

export function applyPageTypography(host: HTMLElement, typography: PickerTypography): void {
  if (typography.fontFamily) host.style.fontFamily = typography.fontFamily;
  if (typography.fontSize) host.style.setProperty(PAGE_FONT_VAR, typography.fontSize);
}

// Representative surface of the page's own action buttons: the most common border-radius
// among the real controls near the injection point (so the trigger matches the row's pill
// shape, not a stray square wrapper) plus the fill/text of a button sharing that shape -
// descending into wrappers, since sites bury the actual <button> inside custom elements.
export function readSiteButtonStyle(point: PickerInsertionPoint): SiteButtonStyle {
  const probes = newProbeCache();
  const entries: SiteButtonStyle[] = [];
  for (const el of collectNearbyControls(point, probes)) {
    const style = readUsableButtonStyle(el, probes);
    if (style) entries.push(style);
  }
  if (entries.length === 0) return rememberedSiteStyle() ?? {};

  const radius = pickRepresentativeRadius(entries.map((entry) => entry.borderRadius));
  // Fill/text come from a control that actually has the chosen shape.
  const surface = entries.find((entry) => entry.borderRadius === radius) ?? entries[0]!;

  const style: SiteButtonStyle = {};
  if (radius) style.borderRadius = radius;
  if (surface.backgroundColor) style.backgroundColor = surface.backgroundColor;
  if (surface.color) style.color = surface.color;
  if (surface.contrastBackgroundColor) {
    style.contrastBackgroundColor = surface.contrastBackgroundColor;
  }
  // Horizontal padding mirrors ONLY the native control we stand beside: the same component
  // on every post of a site, so every trigger gets identical padding. No wider-scan fallback -
  // "most common among nearby clickables" varies per post and produced visibly different
  // widths within one feed. A zero-padding native falls back to the CSS default (0.75em).
  const paddingInline = nativeControlPadding(point, probes);
  if (paddingInline) style.paddingInline = paddingInline;
  normalizeReadableColor(style, getCurrentTheme());

  // Keep the remembered rounded shape if this read caught a squarer transient.
  preferRememberedRadius(style);

  if (style.borderRadius || style.backgroundColor || style.color) {
    rememberSiteStyle(point.target.site, style);
  }
  return style;
}

interface ActionLayout {
  /** The native controls form a vertical rail of icon buttons (reels / shorts). */
  iconColumn: boolean;
  /** Diameter (px) of the native icon button, when measurable. */
  iconSize?: number;
}

// Circle diameter for an icon-column trigger = the native icon button's smaller side
// (its box may be taller than wide when a count label sits beneath the icon), clamped:
// a bare ~24px native icon (Instagram's reel rail) leaves no room between the emoji and
// the gradient ring, and nothing on a rail is legitimately larger than the cap.
const ICON_COLUMN_SIZE_MIN_PX = 36;
const ICON_COLUMN_SIZE_MAX_PX = 72;
// Below this the measurement is a collapsed or not-yet-laid-out box, not an icon - the
// re-blend pass measures again once the rail has laid out.
const ICON_COLUMN_MEASURABLE_MIN_PX = 16;

// The trigger's form is an ADAPTER decision, not a geometric guess: ordinary pages stack wide
// links vertically too (an Amazon product column false-positived into a round trigger), so only
// `triggerLayout: "icon-column"` opts in.
export function readActionLayout(point: PickerInsertionPoint): ActionLayout {
  if (point.triggerLayout !== "icon-column") return { iconColumn: false };

  const probes = newProbeCache();
  const ref = resolveControl(elementsToArray(point.nativeElement)[0] ?? point.anchor) ?? collectNearbyControls(point, probes).find((el) => isVisibleControl(el, probes));
  const layout: ActionLayout = { iconColumn: true };
  if (ref) {
    const rect = probeBox(ref, probes).rect;
    const size = Math.round(Math.min(rect.width, rect.height));
    if (size >= ICON_COLUMN_MEASURABLE_MIN_PX) {
      layout.iconSize = Math.min(ICON_COLUMN_SIZE_MAX_PX, Math.max(ICON_COLUMN_SIZE_MIN_PX, size));
    }
  }
  return layout;
}

// Stamp the icon-column layout hint and the measured icon size on the host. Shared by the
// initial mount and the post-mount re-blend so a rail that lays out late still gets measured.
export function applyActionLayout(host: HTMLElement, point: PickerInsertionPoint): void {
  const layout = readActionLayout(point);
  if (layout.iconColumn) {
    host.setAttribute(LAYOUT_ATTR, "icon-column");
    if (layout.iconSize) {
      host.style.setProperty("--khasky-emojery-icon-size", `${layout.iconSize}px`);
    }
  } else {
    // A host can switch form in place: surfaces share one target key (FB `/watch/?v=<id>`
    // row <-> `/reel/<id>` rail), so the same host moves between them and must drop the
    // icon-column form when it lands back on a horizontal row.
    host.removeAttribute(LAYOUT_ATTR);
    host.style.removeProperty("--khasky-emojery-icon-size");
  }
}

const CLICKABLE_SELECTOR = 'button, [role="button"], a[href]';

// One read pass per element per surface read. Every helper below used to take its own
// getComputedStyle and getBoundingClientRect - a control near the injection point was
// measured three times over (the visibility filter, again inside the style read, again
// for its corner radius) and each ancestor of each control had its background resolved
// from scratch. Nothing WRITES during a surface read, so one snapshot answers all of them.
interface ProbeCache {
  boxes: Map<HTMLElement, { cs: CSSStyleDeclaration; rect: DOMRect }>;
  /** Background composited from the canvas down to and including this element. */
  backgrounds: Map<HTMLElement, RgbaColor>;
}

function newProbeCache(): ProbeCache {
  return { boxes: new Map(), backgrounds: new Map() };
}

function probeBox(el: HTMLElement, probes: ProbeCache): { cs: CSSStyleDeclaration; rect: DOMRect } {
  const hit = probes.boxes.get(el);
  if (hit) return hit;
  const box = { cs: window.getComputedStyle(el), rect: el.getBoundingClientRect() };
  probes.boxes.set(el, box);
  return box;
}

// Real interactive controls near the injection point: the native control first, then every
// clickable in the nearest ancestor holding the action row; wrappers are unwrapped to the
// innermost clickable that carries the visible surface.
function collectNearbyControls(point: PickerInsertionPoint, probes: ProbeCache): HTMLElement[] {
  const out: HTMLElement[] = [];
  const seen = new Set<HTMLElement>();
  const add = (el: HTMLElement | null): void => {
    if (!el || seen.has(el)) return;
    if (el.classList.contains(HOST_CLASS) || el.closest(HOST_SELECTOR)) return;
    if (point.anchor.contains(el) || el.contains(point.anchor)) return;
    seen.add(el);
    out.push(el);
  };

  for (const el of elementsToArray(point.nativeElement)) add(resolveControl(el));

  // Break at the first ancestor holding at least two *visible* clickables - sites keep
  // hidden control clusters in the ancestry (YouTube's off-screen player quick-actions)
  // that would otherwise capture the scan with zero usable buttons.
  let scope = point.anchor.parentElement;
  for (let depth = 0; depth < 4 && scope; depth++, scope = scope.parentElement) {
    const visible = Array.from(scope.querySelectorAll<HTMLElement>(CLICKABLE_SELECTOR)).filter((el) => isVisibleControl(el, probes));
    if (visible.length >= 2) {
      for (const el of visible) add(el);
      break;
    }
  }
  return out;
}

function resolveControl(el: HTMLElement): HTMLElement | null {
  if (el.matches(CLICKABLE_SELECTOR)) return el;
  return el.querySelector<HTMLElement>(CLICKABLE_SELECTOR);
}

// Skips hidden and zero-size controls (collapsed wrappers, off-screen placeholders) -
// their computed surface isn't what the user actually sees.
function isVisibleControl(el: HTMLElement, probes: ProbeCache): boolean {
  const { cs, rect } = probeBox(el, probes);
  if (cs.display === "none" || cs.visibility === "hidden") return false;
  return rect.width > 0 && rect.height > 0;
}

function readUsableButtonStyle(el: HTMLElement, probes: ProbeCache): SiteButtonStyle | null {
  if (!el.isConnected || !isVisibleControl(el, probes)) return null;
  const { cs, rect } = probeBox(el, probes);
  const style: SiteButtonStyle = {};
  const radius = normalizeRadius(cs, rect);
  if (radius) style.borderRadius = radius;
  if (cs.backgroundColor) style.backgroundColor = cs.backgroundColor;
  if (cs.color) style.color = cs.color;
  const contrastBg = effectiveBackgroundColor(el, probes);
  if (contrastBg) style.contrastBackgroundColor = contrastBg;
  return style.borderRadius || style.backgroundColor || style.color ? style : null;
}

// The replaced/adjacent native control's own horizontal padding. Read even when the
// control is hidden (replace-native mode): display:none keeps the authored computed
// padding, which is exactly the rhythm the trigger stands in for. Goes through the
// probe cache like every other read in this pass - collectNearbyControls has usually
// snapshotted this very control already.
function nativeControlPadding(point: PickerInsertionPoint, probes: ProbeCache): string | undefined {
  for (const el of elementsToArray(point.nativeElement)) {
    const control = resolveControl(el);
    if (!control) continue;
    const pad = readPaddingInline(probeBox(control, probes).cs);
    if (pad) return pad;
  }
  return undefined;
}

// Composite the element's own background over everything painted behind it. Memoized per
// ancestor: the controls of one action row share their whole chain above the row, so the
// walk is O(controls + depth) instead of a fresh root walk per control.
function compositedBackground(el: HTMLElement, probes: ProbeCache): RgbaColor {
  const hit = probes.backgrounds.get(el);
  if (hit) return hit;
  const parent = el.parentElement;
  const base = parent ? compositedBackground(parent, probes) : defaultCanvasColor();
  const own = parseRgba(window.getComputedStyle(el).backgroundColor);
  const composited = own && own.a > 0 ? composite(own, base) : base;
  probes.backgrounds.set(el, composited);
  return composited;
}

function effectiveBackgroundColor(el: HTMLElement, probes: ProbeCache): string | null {
  return rgbaToRgbString(compositedBackground(el, probes));
}

function defaultCanvasColor(): RgbaColor {
  const theme = getCurrentTheme();
  return theme === "dark" ? { r: 24, g: 25, b: 26, a: 1 } : { r: 255, g: 255, b: 255, a: 1 };
}

// Collapse an asymmetric border-radius to its largest corner, as a px length: segmented
// controls (YouTube's like/dislike pill, `18px 0 0 18px`) normalise to `18px` so the
// standalone trigger takes the full pill shape instead of a lopsided half-rounding, and a
// circular sibling (`50%`, YouTube's round more-menu button) resolves against its own box to
// a comparable px value - never a literal "50%", which on our wider trigger would bulge the
// ends into an ellipse instead of the site's fixed-radius stadium.
function normalizeRadius(cs: CSSStyleDeclaration, rect: DOMRect): string | undefined {
  const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius];
  const max = largestCornerPx(corners, rect.width, rect.height);
  return max >= 0 ? `${Math.round(max)}px` : cs.borderRadius || undefined;
}

export function applySiteButtonStyle(host: HTMLElement, style: SiteButtonStyle): void {
  // Custom properties on the host inherit through the shadow boundary; the shadow
  // trigger/counter read them via `var(--khasky-emojery-site-*, fallback)`.
  if (style.borderRadius) {
    host.style.setProperty("--khasky-emojery-site-radius", clampRadius(style.borderRadius));
  }
  if (style.backgroundColor) {
    host.style.setProperty("--khasky-emojery-site-bg", style.backgroundColor);
  }
  // Gate the row-height match (picker.css) on a real painted surface: a transparent icon
  // button's tap-target box is not its visible size, so the trigger must not stretch to it.
  host.toggleAttribute("data-khasky-emojery-filled", isSolidFill(style.backgroundColor));
  if (style.color) host.style.setProperty("--khasky-emojery-site-fg", style.color);
  applySitePadding(host, style);
}

// Padding is the one site var that must also be UNSET when absent: a re-blend that finds no
// native padding has to clear what an earlier read stamped, or triggers on this page stay
// sized differently from the rest of the site.
function applySitePadding(host: HTMLElement, style: SiteButtonStyle): void {
  if (style.paddingInline) {
    host.style.setProperty("--khasky-emojery-site-pad-x", style.paddingInline);
  } else {
    host.style.removeProperty("--khasky-emojery-site-pad-x");
  }
}

interface SpacingBaseline {
  x: number;
  y: number;
}

const spacingBaselines = new WeakMap<HTMLElement, SpacingBaseline>();

// Mirror the row's spacing rhythm onto the host. A STRUCTURAL margin (YouTube's watch row keys
// `margin-left` on the sibling arrangement) collapses once a foreign element lands between the
// buttons, so copying the neighbour's margins would read zeros: sample the native gap between
// the two future flanks BEFORE insertion, remember it per host, and give each side exactly what
// it is missing. Skipped for a native wrapper (carries the spacing) or an `append` (not a
// sibling).
export function applyHostSpacing(host: HTMLElement, point: PickerInsertionPoint, opts?: { reuseProbe?: boolean }): void {
  if (point.wrapper || point.position === "append") return;
  if (!point.anchor.isConnected) return;
  const replaced = replacedNativeMargins(point);
  const { left, right } = hostFlanks(host, point);
  if (!left && !right && !replaced) return;

  // The flank margins as the site computes them WITHOUT the host in the row - a structural
  // margin never re-appears while our node sits between the buttons - so a mounted host is
  // lifted out and put back within the same task (nothing flashes). `reuseProbe` skips that
  // forced relayout entirely.
  const native = opts?.reuseProbe ? null : probeNativeFlankMargins(host, left, right);

  // Native gap between the flanks per axis. A successful probe replaces the baseline so
  // layout changes can shrink spacing again; when probing is skipped, keep the last baseline.
  const prior = spacingBaselines.get(host);
  const gap: SpacingBaseline = native
    ? {
        x: native.lRight + native.rLeft,
        y: native.lBottom + native.rTop,
      }
    : (prior ?? { x: 0, y: 0 });
  if (native || !prior) spacingBaselines.set(host, gap);

  // Each side takes over whatever part of the native gap the flank's own margin no longer
  // provides; a missing flank (host at the row's edge) gets none. The replace-hidden
  // native's own margins floor each side - the trigger stands in that control's slot.
  const cur = readFlankMargins(left, right);
  host.style.marginLeft = `${Math.max(replaced?.left ?? 0, left ? Math.max(0, gap.x - cur.lRight) : 0)}px`;
  host.style.marginRight = `${Math.max(replaced?.right ?? 0, right ? Math.max(0, gap.x - cur.rLeft) : 0)}px`;
  host.style.marginTop = `${Math.max(replaced?.top ?? 0, left ? Math.max(0, gap.y - cur.lBottom) : 0)}px`;
  host.style.marginBottom = `${Math.max(replaced?.bottom ?? 0, right ? Math.max(0, gap.y - cur.rTop) : 0)}px`;
}

// Margins of the replace-hidden native control(s): display:none removes its margins from
// the row, so where spacing lives on the control itself the trigger sticks to the next
// action (IG reel rail). The hidden control's computed margins still resolve, so the host
// adopts them as a per-side minimum. Null while the native is visible (its margins still
// space the row; doubling them would widen the gap).
function replacedNativeMargins(point: PickerInsertionPoint): { top: number; right: number; bottom: number; left: number } | null {
  let out: { top: number; right: number; bottom: number; left: number } | null = null;
  for (const el of elementsToArray(point.replaceElement ?? point.nativeElement)) {
    if (el.getAttribute(HIDDEN_ATTR) !== "1" || !el.isConnected) continue;
    const style = window.getComputedStyle(el);
    out ??= { top: 0, right: 0, bottom: 0, left: 0 };
    out.top = Math.max(out.top, marginPx(style.marginTop));
    out.right = Math.max(out.right, marginPx(style.marginRight));
    out.bottom = Math.max(out.bottom, marginPx(style.marginBottom));
    out.left = Math.max(out.left, marginPx(style.marginLeft));
  }
  return out;
}

interface FlankMargins {
  lRight: number;
  lBottom: number;
  rLeft: number;
  rTop: number;
}

function readFlankMargins(left: HTMLElement | null, right: HTMLElement | null): FlankMargins {
  const leftStyle = left ? window.getComputedStyle(left) : null;
  const rightStyle = right ? window.getComputedStyle(right) : null;
  return {
    lRight: leftStyle ? marginPx(leftStyle.marginRight) : 0,
    lBottom: leftStyle ? marginPx(leftStyle.marginBottom) : 0,
    rLeft: rightStyle ? marginPx(rightStyle.marginLeft) : 0,
    rTop: rightStyle ? marginPx(rightStyle.marginTop) : 0,
  };
}

function probeNativeFlankMargins(host: HTMLElement, left: HTMLElement | null, right: HTMLElement | null): FlankMargins | null {
  if (!host.isConnected) {
    return readFlankMargins(left, right);
  }
  // Detaching would restart a running drop animation and drop focus held inside the host;
  // skip then - the caller reuses the last observation and a later pass probes again.
  if (host.classList.contains(BUTTON_DROP_CLASS) || host.contains(document.activeElement)) {
    return null;
  }
  const parent = host.parentNode;
  if (!parent) return null;
  const next = host.nextSibling;
  host.remove();
  const native = readFlankMargins(left, right);
  parent.insertBefore(host, next);
  return native;
}

// The two elements flanking the host's slot: its real siblings once inserted, else the
// anchor's neighbours around the future slot. The anchor goes through the same usability
// filter - with "Replace native" it is already hidden by the time we sample.
function hostFlanks(host: HTMLElement, point: PickerInsertionPoint): { left: HTMLElement | null; right: HTMLElement | null } {
  if (host.isConnected) {
    return {
      left: usableFlank(host.previousElementSibling, "previousElementSibling"),
      right: usableFlank(host.nextElementSibling, "nextElementSibling"),
    };
  }
  return point.position === "before"
    ? {
        left: usableFlank(point.anchor.previousElementSibling, "previousElementSibling"),
        right: usableFlank(point.anchor, "nextElementSibling"),
      }
    : {
        left: usableFlank(point.anchor, "previousElementSibling"),
        right: usableFlank(point.anchor.nextElementSibling, "nextElementSibling"),
      };
}

// Nearest sibling that actually takes part in the row's layout: skip our own nodes (a stale
// host would feed us margins we set ourselves) and boxless elements (hidden natives, <slot>).
function usableFlank(start: Element | null, dir: "previousElementSibling" | "nextElementSibling"): HTMLElement | null {
  // `dir` is a literal union and the walk only reads DOM siblings.
  // nosemgrep: javascript.lang.security.audit.prototype-pollution.prototype-pollution-loop.prototype-pollution-loop
  for (let el = start; el; el = el[dir]) {
    if (!(el instanceof HTMLElement)) continue;
    if (isOwnMountNode(el)) continue;
    const display = window.getComputedStyle(el).display;
    if (display === "none" || display === "contents") continue;
    return el;
  }
  return null;
}

// Relies on mount-registry.ts's wrapHost giving a wrapper EXACTLY ONE child, which is why the
// exactly-one-child test is safe here. It is the tightest of the three "is this ours"
// predicates (mount-registry's hostElementOfMount and isMountNode are looser); a wrapper that
// ever gains a second child makes this one return false, and usableFlank would then sample OUR
// margins as the site's and corrupt applyHostSpacing. Widen wrapHost and this must widen too.
function isOwnMountNode(el: HTMLElement): boolean {
  if (el.classList.contains(HOST_CLASS)) return true;
  const only = el.childElementCount === 1 ? el.firstElementChild : null;
  return only instanceof HTMLElement && only.classList.contains(HOST_CLASS);
}

// Re-apply only the trigger's SIZE + SHAPE from the page's *current* styling, on a short
// schedule after mount (see mount.ts) - Reddit hydrates its buttons a beat late. Colours are
// intentionally NOT re-stamped on this host: a later re-read risks capturing a neighbour's
// hover/active fill. The read itself still refreshes the session's remembered site surface
// (readSiteButtonStyle -> rememberSiteStyle), which mounts with an unreadable row fall back to.
// Returns applyHostRowHeight's "this row's own glyph was measured" verdict, so the caller's
// re-blend schedule can tell a settled trigger from one still wearing a stand-in.
export function reapplyHostShape(host: HTMLElement, point: PickerInsertionPoint): boolean {
  // Both reads first. Writing the typography before reading the surface invalidated
  // style for every getComputedStyle inside readSiteButtonStyle - dozens of them, each
  // then paying a fresh style recalc. The three geometry stages below keep their original
  // order: each reads the row again AFTER the host has taken its new size, and swapping
  // them changes what the next one measures.
  const typography = readPageTypography(point);
  const style = readSiteButtonStyle(point);

  applyPageTypography(host, typography);
  if (style.borderRadius) {
    host.style.setProperty("--khasky-emojery-site-radius", clampRadius(style.borderRadius));
  }
  applySitePadding(host, style);
  const glyphMeasured = applyHostRowHeight(host, point);
  applyHostSpacing(host, point);
  applyActionLayout(host, point);
  return glyphMeasured;
}

// Everything reapplyHostShape stamps, read back off the INLINE style - no computed style,
// no box, so this costs nothing to call. Two identical passes in a row mean the page has
// stopped hydrating under the trigger and the rest of the schedule has nothing left to find.
export function hostShapeSignature(host: HTMLElement): string {
  const s = host.style;
  return [
    s.fontFamily,
    s.marginLeft,
    s.marginRight,
    s.marginTop,
    s.marginBottom,
    s.getPropertyValue(PAGE_FONT_VAR),
    s.getPropertyValue("--khasky-emojery-site-radius"),
    s.getPropertyValue("--khasky-emojery-site-pad-x"),
    s.getPropertyValue("--khasky-emojery-row-h"),
    s.getPropertyValue("--khasky-emojery-glyph-h"),
    s.getPropertyValue("--khasky-emojery-icon-size"),
    host.getAttribute(LAYOUT_ATTR) ?? "",
  ].join("|");
}

// The host is invisible (CSS: [data-khasky-emojery-sizing]) until its glyph size is
// known - the trigger must first paint at its exact size, never resize in front of the
// user (YouTube's watch row hydrates its icons a beat late). Revealed on the first
// successful glyph resolve, or unconditionally by mount.ts's bounded deadline.
const SIZING_ATTR = "data-khasky-emojery-sizing";
const revealedHosts = new WeakSet<HTMLElement>();

export function revealHost(host: HTMLElement): void {
  revealedHosts.add(host);
  host.removeAttribute(SIZING_ATTR);
}

// Stamp the native control's measured sizes on the host: its BOX height as
// --khasky-emojery-row-h (a min-height for filled row pills and for every icon-column trigger -
// see picker.css) and its visible GLYPH height as --khasky-emojery-glyph-h. Zero measurements
// are skipped so a good earlier value survives. Returns whether THIS row's own icon was
// measured, i.e. whether the size is final: a false return means the trigger wears a stand-in
// and the caller owes it another measurement - a row that hydrates its icon past mount.ts's
// 2.4s reblend window (YouTube's watch row) would otherwise keep the stand-in for the life of
// the page.
export function applyHostRowHeight(host: HTMLElement, point: PickerInsertionPoint): boolean {
  const ref = elementsToArray(point.nativeElement)[0];
  if (!ref?.isConnected) return false;
  const boxHeight = ref.getBoundingClientRect().height;
  if (boxHeight > 0) host.style.setProperty("--khasky-emojery-row-h", `${Math.round(boxHeight)}px`);

  const site = point.target.site;
  const measured = nativeGlyphHeight(ref);
  const glyph = glyphPxOrRemembered(site, measured);
  const hasIcons = hasGlyphCandidates(ref);
  if (glyph) {
    host.style.setProperty("--khasky-emojery-glyph-h", `${glyph}px`);
    revealHost(host);
  } else if (!revealedHosts.has(host) && hasIcons) {
    // An icon row whose glyph isn't measurable yet (0x0 mid-hydration): hold the host
    // hidden - the reblend schedule re-measures shortly.
    host.setAttribute(SIZING_ATTR, "");
  }
  // Only a real measurement is final. "This row has no icons" is NOT a stand-in for one:
  // it is a snapshot of a hydrating DOM (YouTube's watch row serves its like/dislike svgs
  // late, and sometimes from inside a shadow root this walk cannot see), and treating it as
  // an answer stopped the re-measure chain on the very rows that needed it.
  return measured !== null;
}

function hasGlyphCandidates(ref: HTMLElement): boolean {
  return ref.matches("svg, img, i") || ref.querySelector("svg, img, i") !== null;
}

// The band a real action-row glyph falls in. Anything smaller is a spacer or a badge dot,
// anything larger is decorative art (a hero image inside the row) that must not win the
// "largest glyph" vote below.
const GLYPH_SIDE_MIN_PX = 10;
const GLYPH_SIDE_MAX_PX = 40;

// The native control's visible icon (svg / img / css-sprite <i>), as distinct from its hit-box
// - the wrong size cue on transparent icon buttons (see picker.css's hit-box note). Each
// candidate contributes its smaller side; only sides inside the band above count, and the
// largest of those is the icon.
function nativeGlyphHeight(ref: HTMLElement): number | null {
  const candidates = ref.matches("svg, img, i") ? [ref] : [...ref.querySelectorAll<HTMLElement>("svg, img, i")];
  let best = 0;
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    const side = Math.min(rect.width, rect.height);
    if (side >= GLYPH_SIDE_MIN_PX && side <= GLYPH_SIDE_MAX_PX && side > best) best = side;
  }
  return best > 0 ? Math.round(best) : null;
}
