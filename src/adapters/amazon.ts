// SPDX-License-Identifier: GPL-3.0-or-later
import type { TargetRef } from "../shared/adapter";
import { queryFirst } from "../shared/dom-query";
import { defineSiteAdapter } from "./framework";
import { findFirstAnchor } from "./placement";
import { matchesAny } from "./runtime";

// Rating block under the product title - primary anchor: the picker sits in the
// review strip alongside the stars/count instead of the right-column buy box.
const RATING_BLOCK_SELECTORS = ["#averageCustomerReviews_feature_div", "#averageCustomerReviews", "#acrPopover", '[data-feature-name="averageCustomerReviews"]'];

// In-stock buy-box selectors - secondary placement when the product
// has no reviews yet and the rating block is absent.
const IN_STOCK_SELECTORS = ["#rightCol .a-box-group", "#desktop_buybox .a-box-group", "#buybox .a-box-group"];

// When the product is unavailable, Amazon swaps the buy box for a "Currently
// unavailable" block; its wrapping feature div anchors the picker above it inside #rightCol.
// Only these two PROVE unavailability; `#availability_feature_div` renders on
// in-stock products too, so it is a placement anchor, not an out-of-stock signal.
const OUT_OF_STOCK_SIGNAL_SELECTORS = ["#outOfStockBuyBox_feature_div", "#outOfStock"];
const OUT_OF_STOCK_SELECTORS = [...OUT_OF_STOCK_SIGNAL_SELECTORS, "#availability_feature_div"];

const PRODUCT_FALLBACK_SELECTORS = ["#title_feature_div", "#title", "#bylineInfo_feature_div", "#centerCol", "#dp-container"];

// Variant widgets ("Size", "Color") update the `/dp/<ASIN>` URL and swap the
// title/review blocks without navigation - prime a scan from those clicks so a
// replaced rating block gets re-anchored.
const VARIATION_CONTROL_SELECTORS = ["#twister [role='button']", "#twister li", "#twister .a-button", "[id^='variation_'] [role='button']", "[id^='variation_'] li", "[id^='variation_'] .a-button", "[id^='size_name_']", "[data-defaultasin]", "[data-dp-url]"];

const amazonAdapter = defineSiteAdapter({
  site: "amazon",
  findCandidates: ({ root }) => {
    const anchor = findFirstAnchor(root, [
      { selectors: RATING_BLOCK_SELECTORS },
      {
        selectors: isOutOfStock(root) ? [...OUT_OF_STOCK_SELECTORS, ...IN_STOCK_SELECTORS] : IN_STOCK_SELECTORS,
      },
      { selectors: PRODUCT_FALLBACK_SELECTORS },
    ]);
    return anchor ? [anchor] : [];
  },
  resolveTarget: () => extractTarget(),
  resolveBinding: (candidate) => {
    // The rating block is replaced visually (native/replace); the buy box is mounted above.
    if (isRatingBlock(candidate)) {
      return {
        anchor: candidate,
        position: "after",
        nativeElement: candidate,
        replaceElement: candidate,
      };
    }
    return {
      anchor: candidate,
      position: isBuyBoxAnchor(candidate) ? "before" : "after",
    };
  },
  observer: {
    navKey: "href",
    linkPrimeSelectors: () => VARIATION_CONTROL_SELECTORS,
    attributeFilter: ["href", "data-asin", "data-defaultasin", "data-dp-url"],
  },
});

function isRatingBlock(el: HTMLElement): boolean {
  return matchesAny(el, RATING_BLOCK_SELECTORS);
}

function isBuyBoxAnchor(el: HTMLElement): boolean {
  return matchesAny(el, [...IN_STOCK_SELECTORS, ...OUT_OF_STOCK_SELECTORS]);
}

function isOutOfStock(root: ParentNode): boolean {
  return !!queryFirst(root, OUT_OF_STOCK_SIGNAL_SELECTORS);
}

function extractTarget(): TargetRef | null {
  const asin = extractAsin();
  if (!asin) return null;
  return amazonTargetFromAsin(asin, location.host);
}

// The asin->target half of the wire contract. `host` is a parameter because a
// regional storefront stores its OWN host (only the id is contractual) - the
// adapter passes `location.host`, `target-contract.ts` the canonical .com.
// Exported so that URL shape has ONE construction site.
export function amazonTargetFromAsin(asin: string, host: string): TargetRef {
  return { site: "amazon", targetId: asin, url: `https://${host}/dp/${asin}` };
}

// Pure; the DOM `<input name="ASIN">` fallback stays in extractAsin since it
// needs the document.
export function asinFromPathname(pathname: string): string | null {
  const asinMatch = pathname.match(/\/(?:dp|gp\/product|product|-\/[a-z]{2}\/dp)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  return asinMatch?.[1] ? asinMatch[1].toUpperCase() : null;
}

function extractAsin(): string | null {
  const fromPath = asinFromPathname(location.pathname);
  if (fromPath) return fromPath;
  const meta = document.querySelector<HTMLInputElement>('input[name="ASIN"], input#ASIN');
  if (meta?.value && /^[A-Z0-9]{10}$/i.test(meta.value)) {
    return meta.value.toUpperCase();
  }
  return null;
}

export default amazonAdapter;
