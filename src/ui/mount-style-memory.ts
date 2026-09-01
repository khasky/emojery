// SPDX-License-Identifier: GPL-3.0-or-later
//
// Remembered site surface: the session cache and durable per-site store behind the trigger's
// blending - held out of mount-style.ts (pure DOM measurement) as the only half touching
// storage. Sites hydrate their controls a beat late, so a first read is often squarer /
// unmeasurable: remember the button SURFACE (never downgraded to a squarer transient read) and
// the last-good per-site GLYPH height, which stands in until a row's own icon becomes
// measurable.
import { storageLocalGet, storageLocalSet } from "../shared/webext";

export interface SiteButtonStyle {
  borderRadius?: string;
  backgroundColor?: string;
  color?: string;
  contrastBackgroundColor?: string;
  /** Native button's horizontal padding, mirrored onto the trigger. */
  paddingInline?: string;
}

const SITE_STYLE_TTL_MS = 24 * 60 * 60 * 1000;

function siteStyleKey(site: string): string {
  return `site_style_v1:${site}`;
}

function siteGlyphKey(site: string): string {
  return `site_glyph_v1:${site}`;
}

interface PersistedSiteStyle {
  style: SiteButtonStyle;
  at: number;
}

interface PersistedSiteGlyph {
  px: number;
  at: number;
}

// The last successful read is cached per session so a mount that can't see its row
// (detached / virtualised) still inherits the site's look.
let lastSiteStyle: SiteButtonStyle | null = null;

// Most-rounded roundness persisted for this site this session (seeded by preloadSiteStyle);
// guards the durable store from a transient squarer read (Reddit's pre-hydration vote button).
let persistedRoundness = -1;

// Per-site glyph height (px): the first successful measure of the session, persisted for
// SITE_STYLE_TTL_MS. Its one job is the unmeasurable row - a reload paints at a plausible
// size immediately instead of re-flashing through the em fallback while a late-hydrating
// icon (YouTube watch) is still 0x0. It never overrides a row that measured its own.
const siteGlyphCanon = new Map<string, number>();

// Roundness of a border-radius, for comparing reads of the same control at different hydration
// stages: its largest px corner. Absent / non-px ("50%" is not resolved against the box here,
// unlike mount-style's normalizeRadius) = -1, so a stray "50%" can never out-round a real pill.
function radiusRoundness(value: string | undefined): number {
  if (!value) return -1;
  let max = -1;
  for (const m of value.matchAll(/(-?[\d.]+)px/g)) {
    const n = Number.parseFloat(m[1]!);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

// Seed the session cache from the durable store at content-script start so the first mount on
// a reload inherits the remembered shape instead of racing late hydration. Fire-and-forget.
export async function preloadSiteStyle(site: string): Promise<void> {
  try {
    const key = siteStyleKey(site);
    const glyphKey = siteGlyphKey(site);
    const stored = await storageLocalGet([key, glyphKey]);
    const glyphEntry = stored[glyphKey] as PersistedSiteGlyph | undefined;
    if (glyphEntry && typeof glyphEntry.px === "number" && typeof glyphEntry.at === "number" && Date.now() - glyphEntry.at <= SITE_STYLE_TTL_MS && !siteGlyphCanon.has(site)) {
      siteGlyphCanon.set(site, glyphEntry.px);
    }
    const entry = stored[key] as PersistedSiteStyle | undefined;
    if (!entry || typeof entry.at !== "number") return;
    if (Date.now() - entry.at > SITE_STYLE_TTL_MS) return;
    if (!entry.style || typeof entry.style !== "object") return;
    // Padding is native-derived per mount, never part of the remembered surface -
    // drop it from older stores so a stale per-row sample can't resurface.
    delete entry.style.paddingInline;
    // A legacy radius stored as a "%"/circle shape (captured before radii were resolved to
    // px) would seed a rounder-than-any-pill remembered shape that hijacks every mount - drop
    // it so the first live read heals the store with a real px pill radius.
    if (entry.style.borderRadius?.includes("%")) delete entry.style.borderRadius;
    // Don't clobber a live style the running page may have already read.
    if (!lastSiteStyle) lastSiteStyle = entry.style;
    persistedRoundness = Math.max(persistedRoundness, radiusRoundness(entry.style.borderRadius));
  } catch {
    // storage unavailable - the live read path still works.
  }
}

// The session's last good surface, for a mount whose own row is unreadable.
export function rememberedSiteStyle(): SiteButtonStyle | null {
  return lastSiteStyle;
}

// Record a fresh successful read: always into the session cache, and into the durable store
// only when MORE rounded than what's stored (never downgrade a remembered pill to a transient
// square). The roundness gate throttles the writes implicitly.
export function rememberSiteStyle(site: string, style: SiteButtonStyle): void {
  lastSiteStyle = style;
  const roundness = radiusRoundness(style.borderRadius);
  if (roundness <= persistedRoundness) return;
  persistedRoundness = roundness;
  const persistable: SiteButtonStyle = { ...style };
  delete persistable.paddingInline;
  const entry: PersistedSiteStyle = { style: persistable, at: Date.now() };
  void storageLocalSet({ [siteStyleKey(site)]: entry }).catch(() => {});
}

// Prefer a remembered rounded radius over a freshly-read squarer one (a mid-hydration read
// must not overwrite it). Only compares when the fresh read HAS a radius, so a row with
// genuinely no radius still reads as none.
export function preferRememberedRadius(style: SiteButtonStyle): void {
  const remembered = lastSiteStyle?.borderRadius;
  if (!remembered || !style.borderRadius) return;
  if (radiusRoundness(remembered) > radiusRoundness(style.borderRadius)) {
    style.borderRadius = remembered;
  }
}

// Test-only: drop the session memory so a spec starts from a cold content
// script instead of inheriting the previous test's canon/roundness.
export function resetSiteStyleMemoryForTests(): void {
  lastSiteStyle = null;
  persistedRoundness = -1;
  siteGlyphCanon.clear();
}

// The glyph height this site paints at: the canon if one exists, otherwise this measurement -
// which becomes the canon. Null when nothing has ever been measurable (the em fallback wins).
export function glyphPxOrRemembered(site: string, measured: number | null): number | null {
  if (measured && !siteGlyphCanon.has(site)) {
    siteGlyphCanon.set(site, measured);
    const entry: PersistedSiteGlyph = { px: measured, at: Date.now() };
    void storageLocalSet({ [siteGlyphKey(site)]: entry }).catch(() => {});
  }
  // A row that CAN be measured always paints its own size; the remembered value only covers a
  // row that cannot. One platform's surfaces are not one size (YouTube's Shorts rail draws 24px
  // icons, its watch row 18px), so letting the first surface visited outrank a live read
  // mis-sized the trigger for the whole TTL.
  return measured ?? siteGlyphCanon.get(site) ?? null;
}
