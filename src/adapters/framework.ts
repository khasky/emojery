// SPDX-License-Identifier: GPL-3.0-or-later
//
// Adapter framework: a thin, declarative-first skeleton every site adapter
// shares. `defineSiteAdapter()` returns a plain `SiteAdapter`: each
// `entrypoints/*.content.ts` hands it to `ui/content-entry.ts`, which calls
// `observe()`; its points mount via `mountAll`/`mountAt`.
// All site-specific knowledge stays in callbacks; `resolveBinding` returns a
// ready `PickerInsertionPoint` minus its `target`, so the framework never
// reinterprets a site's placement.
import type { PickerInsertionPoint, SiteAdapter, SupportedSite, TargetRef } from "../shared/adapter";
import { detectSupportedSite } from "../shared/sites";
import { createScanObserver, type ScanObserverOptions } from "./scan-observer";

export interface ScanContext {
  root: ParentNode;
  // Per-scan target dedupe, owned by the framework - read by Facebook's
  // shared-photo collision handler, never a callback's to mutate. The container
  // dedupe stays private to the scan loop; no callback needs it.
  seenTargets: Set<string>;
  // Memoize a derived value for the current scan. Caches `null` / falsy results
  // too (via cache.has), so a negative lookup isn't recomputed. For a value the
  // whole scan shares (a parse of the page URL, keyed on `root`); a per-candidate
  // lookup goes through `resolveRow` instead.
  memo<T>(key: object, compute: () => T): T;
}

export type Binding = Omit<PickerInsertionPoint, "target">;

type ScanObserverProfile = Omit<ScanObserverOptions, "onUpdate" | "scan">;

export interface SiteAdapterSpec<Row = null> {
  site: SupportedSite;
  // Page-level privacy gate. When true the scan yields NO points - the extension
  // never shows on a page whose content isn't viewable by an anonymous public
  // visitor (private repos / projects / groups / accounts): a reaction can only
  // be recorded for a publicly addressable target. Runs once per scan, before
  // any candidate work. See page-visibility.ts.
  isPrivatePage?(ctx: ScanContext): boolean;
  // The DOM elements a binding starts from.
  findCandidates(ctx: ScanContext): Iterable<HTMLElement>;
  // The per-candidate lookup the three callbacks below share - typically the
  // action row the candidate sits in. Run once per candidate per scan and handed
  // to each as `row`; `null` drops the candidate before any of them runs.
  resolveRow?(candidate: HTMLElement, ctx: ScanContext): Row | null;
  resolveTarget(candidate: HTMLElement, ctx: ScanContext, row: Row): TargetRef | null;
  resolveBinding(candidate: HTMLElement, ctx: ScanContext, row: Row): Binding | null;
  // Container-level dedupe (e.g. one point per visual action row). Returning
  // null or an already-seen container drops the candidate before target work.
  dedupeContainer?(candidate: HTMLElement, ctx: ScanContext, row: Row): HTMLElement | null;
  // Observer: standard re-scan options, extended per site via plugins - Reddit's
  // shadow roots and Facebook's hover priming both ride on those.
  observer?: ScanObserverProfile;
}

export function defineSiteAdapter<Row = null>(spec: SiteAdapterSpec<Row>): SiteAdapter {
  const scan = (root: ParentNode): PickerInsertionPoint[] => {
    const cache = new WeakMap<object, unknown>();
    const ctx: ScanContext = {
      root,
      seenTargets: new Set<string>(),
      memo<T>(key: object, compute: () => T): T {
        if (cache.has(key)) return cache.get(key) as T;
        const value = compute();
        cache.set(key, value);
        return value;
      },
    };
    if (spec.isPrivatePage?.(ctx)) return [];

    const points: PickerInsertionPoint[] = [];
    const seenContainers = new Set<HTMLElement>();
    for (const candidate of spec.findCandidates(ctx)) {
      let row: Row;
      if (spec.resolveRow) {
        const resolved = spec.resolveRow(candidate, ctx);
        if (resolved === null) continue;
        row = resolved;
      } else {
        row = null as Row;
      }
      if (spec.dedupeContainer) {
        const container = spec.dedupeContainer(candidate, ctx, row);
        if (!container || seenContainers.has(container)) continue;
        seenContainers.add(container);
      }
      const target = spec.resolveTarget(candidate, ctx, row);
      if (!target || ctx.seenTargets.has(target.targetId)) continue;
      const binding = spec.resolveBinding(candidate, ctx, row);
      if (!binding) continue;
      // Mark seen only AFTER a binding is produced: a candidate that yields no
      // binding must not consume its target, so a later candidate resolving to
      // the same target can still mount.
      ctx.seenTargets.add(target.targetId);
      points.push({ ...binding, target });
    }
    return points;
  };

  const observe = (onUpdate: (points: PickerInsertionPoint[]) => void): (() => void) => {
    return createScanObserver({
      onUpdate,
      scan: () => scan(document),
      ...(spec.observer ?? {}),
    });
  };

  // The registry's run-host contract: `detectSupportedSite` alone decides which hosts an adapter runs on.
  const matches = (host: string): boolean => detectSupportedSite(host) === spec.site;
  return { site: spec.site, matches, scan, observe };
}
