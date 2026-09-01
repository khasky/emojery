// SPDX-License-Identifier: GPL-3.0-or-later
//
// Generic-fixture tests for the selector-list query helpers. The fixtures are
// plain divs/spans with test classes (framework contract only - no simulated
// supported-site markup, per the repo testing rule).
import { describe, expect, it } from "vitest";
import { queryAll, queryAllDeep, queryFirst } from "./dom-query";

const BAD_SELECTOR = "!!not-a-selector!!";

function build(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

describe("queryFirst", () => {
  it("selector-list order wins over DOM order", () => {
    const root = build('<span class="second"></span><div class="first"></div>');
    const hit = queryFirst(root, ["div.first", "span.second"]);
    expect(hit?.className).toBe("first");
  });

  it("swallows an invalid selector literal and tries the rest", () => {
    const root = build('<div class="hit"></div>');
    expect(queryFirst(root, [BAD_SELECTOR, ".hit"])?.className).toBe("hit");
  });

  it("returns null when nothing matches (including all-invalid lists)", () => {
    const root = build('<div class="hit"></div>');
    expect(queryFirst(root, [".miss"])).toBeNull();
    expect(queryFirst(root, [BAD_SELECTOR])).toBeNull();
  });
});

describe("queryAll", () => {
  it("dedupes an element matched by several selectors, first-selector order", () => {
    const root = build('<div class="a b"></div><span class="b"></span>');
    const out = queryAll(root, [".a", ".b", ".a"]);
    expect(out).toHaveLength(2);
    expect(out[0]?.className).toBe("a b");
    expect(out[1]?.className).toBe("b");
  });

  it("swallows an invalid selector literal and keeps the remaining hits", () => {
    const root = build('<div class="hit"></div><div class="hit"></div>');
    expect(queryAll(root, [BAD_SELECTOR, ".hit"])).toHaveLength(2);
  });
});

describe("queryAllDeep", () => {
  function shadowHost(inner: string): HTMLElement {
    const host = document.createElement("div");
    document.body.appendChild(host);
    host.attachShadow({ mode: "open" }).innerHTML = inner;
    return host;
  }

  it("finds matches in light DOM and nested open shadow roots", () => {
    const host = shadowHost('<span class="hit shallow"></span><div id="inner-host"></div>');
    const innerHost = host.shadowRoot?.getElementById("inner-host");
    innerHost?.attachShadow({ mode: "open" });
    if (innerHost?.shadowRoot) innerHost.shadowRoot.innerHTML = '<span class="hit deep"></span>';
    const light = document.createElement("span");
    light.className = "hit light";
    document.body.appendChild(light);

    const classes = queryAllDeep(document.body, [".hit"]).map((el) => el.className);
    expect(classes).toContain("hit light");
    expect(classes).toContain("hit shallow");
    expect(classes).toContain("hit deep");
    expect(classes).toHaveLength(3);
  });

  it("descends into the root's own shadow root when the root is the host", () => {
    const host = shadowHost('<span class="hit"></span>');
    expect(queryAllDeep(host, [".hit"])).toHaveLength(1);
  });

  it("dedupes across the selector list in shadow content", () => {
    const host = shadowHost('<span class="a b"></span>');
    expect(queryAllDeep(host, [".a", ".b"])).toHaveLength(1);
  });
});
