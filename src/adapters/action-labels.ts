// SPDX-License-Identifier: GPL-3.0-or-later
//
// Shared, locale-independent action-label matching. Sites label their action
// controls (Like / Reply / Share / ...) in many languages and via several signals -
// aria-label, visible text, a stable SVG `data-icon` (X), or an SVG path prefix
// (Threads). This module owns the matching engine and stem vocabulary; each site
// declares its own small registry of the signals it exposes.
// Matching precedence per control: exact label -> data-icon -> icon-path -> stems.
import { collapseWhitespace } from "./runtime";

export type ActionKind = "like" | "comment" | "reply" | "share" | "send" | "repost" | "bookmark";

interface ActionMatcher {
  /** Exact aria-label / svg[aria-label] values, matched case-insensitively. */
  exact?: readonly string[];
  /** aria-label / visible-text regex stems (use the `/iu` flags). */
  stems?: RegExp;
  /** Stable SVG `data-icon` value (X), tested against a descendant svg[data-icon]. */
  dataIcon?: RegExp;
  /** Distinctive `svg path[d]` prefix(es) (Threads), whitespace-normalised. */
  iconPathPrefix?: string | readonly string[];
}

export type ActionRegistry = Partial<Record<ActionKind, ActionMatcher>>;

export interface LabelRegistryOptions {
  /** Labels rejected outright (e.g. Instagram's comment-menu kebab). */
  reject?: RegExp;
  /** Treat an aria-label containing `: <digit>` (a count summary like
   *  "Like: 68") as no label, not an action. Default true (mirrors Facebook). */
  rejectCountSummary?: boolean;
  /** Fall back to visible text when the control has no aria-label. Default true;
   *  X and Threads opt out (they match by icon / aria-label only). */
  useTextFallback?: boolean;
  /** Also read descendant `svg[aria-label]` values as labels. Default true
   *  (Threads labels live on a child svg); adapters whose labels sit on the
   *  control element itself set this false. */
  readDescendantSvgLabels?: boolean;
  /** Control selector for findActionControl / presentKinds scans. */
  controlSelector?: string;
}

export interface LabelRegistry {
  classify(el: Element): ActionKind | null;
  matchAction(el: Element, kind: ActionKind): boolean;
  findActionControl(row: ParentNode, kind: ActionKind): HTMLElement | null;
  presentKinds(root: ParentNode): Set<ActionKind>;
}

// Stem vocabulary decomposed per locale/synonym so each word lives in ONE place.
// Adapters compose only the parts they want via `stem(...)` - omitting a locale
// narrows matching intentionally:
//   - Instagram/Facebook ship EN/RU/UA only (German `gefällt`/`teilen` would
//     over-match FB's own German UI) and skip the retweet/reshare synonyms.
//   - X exposes Repost/Retweet but never "Reshare".
// Threads is not a consumer: it matches by SVG icon-path plus its own anchored,
// English-only stems.
export const STEM_PARTS = {
  like: { en: /\b(?:un)?like(?:d)?\b/iu, ru: /нрав/iu, ua: /подоба|вподоб/iu, de: /gefällt/iu },
  comment: { en: /\bcomment\b/iu, ru: /комментир|комментар/iu, ua: /коментув|коментар/iu },
  reply: { en: /\breply\b/iu, ru: /ответ/iu, ua: /відпов/iu, de: /antwort/iu },
  share: { en: /\bshare\b/iu, ru: /подели/iu, ua: /поділи/iu, de: /teilen/iu },
  send: { en: /\bsend\b/iu, ru: /отправ|переслат/iu, ua: /надісл|надсила/iu },
  repost: {
    repost: /\brepost\b/iu,
    retweet: /retweet/iu,
    // Composed by no shipped adapter, and kept anyway: x.ts documents that it OMITS this
    // one, and stem-composition.test.ts pins that omission. Threads spells "reshare" into
    // its own inline regex because it matches on an icon path, not on this vocabulary.
    reshare: /reshare/iu,
    repostRu: /репост/iu,
    retweetUk: /ретвіт/iu,
    poshyryt: /поширит/iu,
  },
  bookmark: { en: /\bbookmark\b/iu, ru: /заклад/iu, de: /lesezeichen/iu },
} as const;

export function stem(...parts: RegExp[]): RegExp {
  return new RegExp(parts.map((p) => p.source).join("|"), "iu");
}

// Full per-action locale union; narrower adapters compose a subset from STEM_PARTS.
export const STEM = {
  like: stem(STEM_PARTS.like.en, STEM_PARTS.like.ru, STEM_PARTS.like.ua, STEM_PARTS.like.de),
  comment: stem(STEM_PARTS.comment.en, STEM_PARTS.comment.ru, STEM_PARTS.comment.ua),
  reply: stem(STEM_PARTS.reply.en, STEM_PARTS.reply.ru, STEM_PARTS.reply.ua, STEM_PARTS.reply.de),
  share: stem(STEM_PARTS.share.en, STEM_PARTS.share.ru, STEM_PARTS.share.ua, STEM_PARTS.share.de),
  send: stem(STEM_PARTS.send.en, STEM_PARTS.send.ru, STEM_PARTS.send.ua),
  // No `repost` here: every consumer (x.ts, instagram.ts) composes its own
  // narrower repost subset from STEM_PARTS.
  bookmark: stem(STEM_PARTS.bookmark.en, STEM_PARTS.bookmark.ru, STEM_PARTS.bookmark.de),
} as const;

// Narrower than the same-named constant in visual-action-row.ts, which also takes
// `a[href]`. Deliberate, not drift: this one classifies LABELLED ACTIONS, where a link
// is usually navigation rather than an action; that one finds the visual slot in a row,
// and there a link can be the control (GitHub's Star is an `<a href>` - see github.ts).
// Keep them apart.
const DEFAULT_CONTROL_SELECTOR = 'button, [role="button"]';

// A reaction-count summary ("Like: 68 people") rather than an action control.
// Exported because Facebook's adapter applies the same rule outside the registry
// (facebook-post-row.ts), and the two must agree on what a count looks like.
export function isCountSummary(label: string): boolean {
  return /:\s*\d/.test(label);
}

export function defineLabelRegistry(registry: ActionRegistry, options: LabelRegistryOptions = {}): LabelRegistry {
  const rejectCountSummary = options.rejectCountSummary !== false;
  const useTextFallback = options.useTextFallback !== false;
  const readDescendantSvgLabels = options.readDescendantSvgLabels !== false;
  const controlSelector = options.controlSelector ?? DEFAULT_CONTROL_SELECTOR;
  const entries = Object.entries(registry) as Array<[ActionKind, ActionMatcher]>;

  // A count-summary aria-label ("Like: 68") yields NO label and does not fall
  // through to visible text - the element is a count.
  const labelStrings = (el: Element): string[] => {
    const out: string[] = [];
    const ownAria = el.getAttribute("aria-label");
    if (ownAria != null) {
      if (!(rejectCountSummary && isCountSummary(ownAria))) out.push(ownAria);
    } else if (useTextFallback) {
      const text = collapseWhitespace(el.textContent ?? "");
      if (text) out.push(text);
    }
    if (readDescendantSvgLabels) {
      for (const svg of Array.from(el.querySelectorAll("svg[aria-label]"))) {
        const label = svg.getAttribute("aria-label");
        if (label && !(rejectCountSummary && isCountSummary(label))) out.push(label);
      }
    }
    return out;
  };

  const dataIcons = (el: Element): string[] => {
    const out: string[] = [];
    const own = el.getAttribute("data-icon");
    if (own) out.push(own);
    for (const svg of Array.from(el.querySelectorAll("svg[data-icon]"))) {
      const icon = svg.getAttribute("data-icon");
      if (icon) out.push(icon);
    }
    return out;
  };

  const iconPaths = (el: Element): string[] => {
    const out: string[] = [];
    // `el` may BE the <svg>: Instagram labels the icon element itself, so the
    // registry classifies svgs directly and a descendant-only query finds nothing.
    for (const path of Array.from(el.querySelectorAll(el.matches("svg") ? "path[d]" : "svg path[d]"))) {
      const pathData = collapseWhitespace(path.getAttribute("d") ?? "");
      if (pathData) out.push(pathData);
    }
    return out;
  };

  const matchExact = (labels: string[], values: readonly string[]): boolean => labels.some((l) => values.some((v) => l.toLowerCase() === v.toLowerCase()));

  const matchPathPrefix = (paths: string[], prefix: string | readonly string[]): boolean => {
    const prefixes = typeof prefix === "string" ? [prefix] : prefix;
    return paths.some((d) => prefixes.some((p) => d.startsWith(p)));
  };

  const classify = (el: Element): ActionKind | null => {
    const labels = labelStrings(el);
    // Hoist optional props to consts: TS narrowing does not survive into the closures below.
    const reject = options.reject;
    if (reject && labels.some((l) => reject.test(l))) return null;
    for (const [kind, m] of entries) {
      if (m.exact && matchExact(labels, m.exact)) return kind;
    }
    const icons = dataIcons(el);
    for (const [kind, m] of entries) {
      const dataIcon = m.dataIcon;
      if (dataIcon && icons.some((i) => dataIcon.test(i))) return kind;
    }
    const paths = iconPaths(el);
    for (const [kind, m] of entries) {
      if (m.iconPathPrefix && matchPathPrefix(paths, m.iconPathPrefix)) return kind;
    }
    for (const [kind, m] of entries) {
      const stems = m.stems;
      if (stems && labels.some((l) => stems.test(l))) return kind;
    }
    return null;
  };

  const matchAction = (el: Element, kind: ActionKind): boolean => classify(el) === kind;

  const findActionControl = (row: ParentNode, kind: ActionKind): HTMLElement | null => {
    for (const ctrl of Array.from(row.querySelectorAll<HTMLElement>(controlSelector))) {
      if (classify(ctrl) === kind) return ctrl;
    }
    return null;
  };

  const presentKinds = (root: ParentNode): Set<ActionKind> => {
    const kinds = new Set<ActionKind>();
    for (const ctrl of Array.from(root.querySelectorAll<HTMLElement>(controlSelector))) {
      const kind = classify(ctrl);
      if (kind) kinds.add(kind);
    }
    return kinds;
  };

  return { classify, matchAction, findActionControl, presentKinds };
}
