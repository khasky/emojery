// SPDX-License-Identifier: GPL-3.0-or-later

import { readFileSync } from "node:fs";
import { glob, mkdir, rename } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import preact from "@preact/preset-vite";
import { parse as parseDotenv } from "dotenv";
import { defineConfig } from "wxt";
import { shrinkCss } from "./scripts/lib/css-shrink.mjs";
import { PRODUCTION_API_BASE, STAGING_API_BASE } from "./src/shared/api-origins";
import { HOMEPAGE_MATCH_PATTERN } from "./src/shared/homepage";
import { ALL_SITE_MATCH_PATTERNS } from "./src/shared/sites";
import { withExtensionUtm } from "./src/shared/tracking-links";
import { WEB_ACCESSIBLE_RESOURCES } from "./src/shared/web-accessible-resources";

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveBuildMode(): string {
  const argv = process.argv;
  const flag = argv.findIndex((a) => a === "--mode" || a === "-m");
  const next = flag !== -1 ? argv[flag + 1] : undefined;
  if (next) return next;
  const inline = argv.find((a) => a.startsWith("--mode="));
  if (inline) return inline.slice("--mode=".length);
  // Never from NODE_ENV. The mode below decides which WXT_API_BASE is accepted and whether
  // the debug channel folds away, so an ambient env var must not be able to turn `wxt build`
  // into a development build. The subcommand is what the operator typed: `wxt` on its own
  // (or with only flags) is the dev server, anything else builds.
  const subcommand = argv[2];
  return subcommand === undefined || subcommand.startsWith("-") ? "development" : "production";
}
const BUILD_MODE = resolveBuildMode();

function readEnvFile(rel: string): Record<string, string> {
  try {
    return parseDotenv(readFileSync(resolve(__dirname, rel), "utf8"));
  } catch {
    return {};
  }
}

// Build-time API-base override, injected into the bundle as
// __EM_API_BASE_OVERRIDE__ (see src/shared/config.ts) and mirrored in the
// manifest host permission. Non-production modes accept any override; a
// production build only accepts the staging base (the e2e build points there),
// so a rejected value never reaches the artifact.
function resolveApiBaseOverride(mode: string): string {
  const envOverride = process.env.WXT_API_BASE || "";
  if (mode === "production") {
    return envOverride === STAGING_API_BASE ? envOverride : "";
  }
  return envOverride || readEnvFile(`.env.${mode}.local`).WXT_API_BASE || readEnvFile(`.env.${mode}`).WXT_API_BASE || "";
}
const API_BASE_OVERRIDE = resolveApiBaseOverride(BUILD_MODE);

// The single API origin this build talks to - the source for both the manifest
// host permission and the CSP `connect-src` below, so the two can never drift.
function resolveApiOrigin(mode: string | undefined): string {
  const modeDefault = mode === "staging" ? STAGING_API_BASE : PRODUCTION_API_BASE;
  const raw = API_BASE_OVERRIDE || modeDefault;
  try {
    return new URL(raw).origin;
  } catch {
    return modeDefault;
  }
}

// The picker mounts into a shadow root, so its stylesheet travels as a STRING
// (`import css from "./picker.css?raw"`) and is inlined into every content-script bundle
// that imports it, each copy carrying the file's full rationale comments - a large share
// of each bundle's budget in scripts/check-bundle-budget.mjs (`pnpm check:bundle` prints
// the current sizes). This strips the bytes no parser keeps.
//
// Build only: `pnpm dev` keeps the readable text in the browser's Sources panel, and the
// test runners have their own configs, so a test always reads the stylesheet as authored.
// scripts/lib/css-shrink.test.mjs pins the transform's string/url() safety; the CSSOM
// equivalence check runs in a real browser in src/ui/picker-css.browser.test.tsx.
function shrinkRawCssPlugin() {
  return {
    name: "emojery:shrink-raw-css",
    // Ahead of Vite's own `?raw` loader, so this owns the module's contents.
    enforce: "pre" as const,
    load(id: string) {
      if (!id.endsWith(".css?raw")) return null;
      const file = id.slice(0, -"?raw".length);
      return `export default ${JSON.stringify(shrinkCss(readFileSync(file, "utf8")))};`;
    },
  };
}

// Removes the source-map entries from one of WXT's build-output file lists, in place:
// the lists are handed to the `build:done` hook as `Readonly<BuildOutput>`, which
// freezes the properties, not the arrays.
function forgetSourcemaps(files: { fileName: string }[]): void {
  for (let i = files.length - 1; i >= 0; i--) {
    if (files[i]?.fileName.endsWith(".map")) files.splice(i, 1);
  }
}

export default defineConfig({
  srcDir: "src",
  outDir: ".output",
  publicDir: resolve(__dirname, "public"),
  vite: (env) => ({
    define: {
      __EM_STAGING_BUILD__: JSON.stringify(BUILD_MODE === "staging"),
      __EM_API_BASE_OVERRIDE__: JSON.stringify(API_BASE_OVERRIDE),
      // Console debug channels (background/debug.ts). `false` in a production
      // build, so the channels AND their redactor tree-shake out of the shipped
      // bundle. This replaced a runtime "is this unpacked?" guess (no `update_url`
      // in the manifest): that guess decided at run time whether request bodies -
      // the pages a user reacted to - reach a console, and it had to be right on
      // every install path a store might invent. A build-time constant cannot be
      // wrong on a store build, because the branch is not in it.
      __EM_DEBUG_LOG__: JSON.stringify(BUILD_MODE !== "production"),
      // Folds shared/i18n.ts's English fallback to dead code, so the generated
      // dictionary tree-shakes out of every bundle: inside an extension
      // `chrome.i18n.getMessage` always answers, and the fallback exists only for
      // Vitest/jsdom, where this constant is undefined. `src/shared/i18n.test.ts`
      // pins the runtime behaviour; `scripts/check-bundle-budget.mjs` pins the drop.
      __EM_I18N_FALLBACK__: JSON.stringify(false),
      // Build stamp shown next to the version in the popup header. Staging keeps a
      // full ISO instant for debugging; production is truncated to YYYY-MM (UTC) so
      // an AMO reviewer's rebuild is byte-identical within the same calendar month.
      __EM_BUILD_TIME__: JSON.stringify(BUILD_MODE === "staging" ? new Date().toISOString() : new Date().toISOString().slice(0, 7)),
    },
    plugins: [preact() as never, ...(env.command === "build" ? [shrinkRawCssPlugin() as never] : [])],
    // Extension pages load their chunks from disk, so a preload hint buys nothing
    // and Chrome logs "cross-world extension resource mismatch" for every chunk
    // an entrypoint splits out but does not execute on first paint.
    //
    // `hidden` writes the .map files but appends no `sourceMappingURL` comment, so
    // the shipped bytes are byte-for-byte what a `sourcemap: false` build produces -
    // the AMO rebuild stays reproducible and scan-extension-artifact.sh's
    // `sourceMappingURL` rule stays satisfied. The maps themselves leave the output
    // directory in the `build:done` hook below. Dev is left alone: the serve build's
    // own inline maps are what the devtools use.
    build: { modulePreload: false, ...(env.command === "build" ? ({ sourcemap: "hidden" } as const) : {}) },
  }),
  manifest: ({ browser, mode }) => ({
    default_locale: "en",
    // Staging builds get a literal name suffix (the `__MSG_extName__` token is still
    // i18n-substituted) so staging and prod are distinguishable when loaded side by side.
    name: mode === "staging" ? "__MSG_extName__ (Staging)" : "__MSG_extName__",
    short_name: "__MSG_extShortName__",
    description: "__MSG_extDescription__",
    ...(browser === "firefox" ? { developer: { name: "khasky", url: "https://github.com/khasky" } } : {}),
    // Surfaces as "Open extension website" on the browser's extension page.
    homepage_url: withExtensionUtm("https://emojery.app/", {
      campaign: "manifest_links",
      content: "homepage_url",
    }),
    // unlimitedStorage lifts `storage.local`'s 10MB cap and exempts the origin's
    // IndexedDB from eviction, for the uncapped device-local reaction history
    // (adds no user-facing permission warning).
    // `scripting` carries no warning of its own (it can only reach the hosts below) and buys
    // the fresh-install replay into already-open tabs - see background/install.ts.
    permissions: ["storage", "unlimitedStorage", "alarms", "activeTab", "scripting"],
    // The homepage pattern lets the popup read the active tab's URL on emojery.app so its
    // header logo switches to the homepage variant (shared/homepage.ts, which owns the host).
    host_permissions: [...ALL_SITE_MATCH_PATTERNS, HOMEPAGE_MATCH_PATTERN, `${resolveApiOrigin(mode)}/*`],
    // Pin the CSP explicitly rather than inheriting the tool default, and lock down
    // base-uri/frame-ancestors. `connect-src` is the one that carries security weight:
    // the auth page and the background worker both hold a bearer token, so an injection
    // that ever landed on an extension page could otherwise POST it anywhere. It is
    // pinned to this build's own API origin (resolveApiOrigin, same value as the host
    // permission above) plus `self` for the packaged emoji-data/icon fetches. Still no
    // `default-src`: that would need img/style/font entries for the popup's bundled
    // styles and the emoji sprite, and those load no remote content anyway.
    // `form-action 'none'` and `child-src 'none'` add nothing to functionality - no
    // extension page frames, spawns a worker, or submits a form natively (the auth
    // form fetches via a preventDefault handler) - so they close the fallback native
    // submit / frame / worker sinks a future injection could otherwise reach.
    content_security_policy: {
      extension_pages: `script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; child-src 'none'; connect-src 'self' ${resolveApiOrigin(mode)}`,
    },
    action: {
      default_title: "__MSG_extActionTitle__",
      default_popup: "popup.html",
      default_icon: {
        16: "icons/icon-16.png",
        32: "icons/icon-32.png",
        48: "icons/icon-48.png",
        128: "icons/icon-128.png",
      },
    },
    icons: {
      16: "icons/icon-16.png",
      32: "icons/icon-32.png",
      48: "icons/icon-48.png",
      128: "icons/icon-128.png",
    },
    // The `matches` gate holds on MV3 only: WXT builds Firefox as MV2, whose
    // flat resource list has no per-origin form, so there these files are
    // reachable from any page that knows the extension's origin - which Firefox
    // randomizes per install, and nothing here publishes it. That is why the list
    // itself is the guarded thing: shared/web-accessible-resources.ts owns it and
    // its test refuses an entry whose disclosure has not been reviewed.
    web_accessible_resources: [
      {
        resources: [...WEB_ACCESSIBLE_RESOURCES],
        matches: [...ALL_SITE_MATCH_PATTERNS],
      },
    ],
    ...(browser === "firefox"
      ? {
          browser_specific_settings: {
            gecko: {
              id: "extension@emojery.app",
              // 128 is the floor the code itself needs; the data-consent floor sits at 140/142.
              // Pinning 140/142 would be the shortcut for Mozilla's built-in consent screen,
              // but it locks out every fork still on the previous ESR. The highest API this
              // build actually needs is `inert` (Firefox 112); 128 is the nearest ESR above it.
              // Older builds get our own disclosure instead - see needsLegacyDataConsentNotice
              // in shared/data-consent.ts.
              strict_min_version: "128.0",
              data_collection_permissions: {
                required: ["authenticationInfo", "websiteContent", "personallyIdentifyingInfo"],
                optional: ["technicalAndInteraction"],
              },
            },
            gecko_android: {
              // General add-on support (any AMO listing, not just the curated collection) landed
              // in Firefox for Android 120; keep desktop and Android on the same ESR floor.
              strict_min_version: "128.0",
            },
          },
        }
      : {}),
  }),
  zip: {
    compressionLevel: 0,
    artifactTemplate: "{{name}}-v{{version}}-{{browser}}-{{manifestVersion}}.zip",
    // No `{{browser}}` here on purpose - the archive is browser-independent. Which is
    // also why `zipSources` is left at the WXT default (firefox + opera only, see
    // resolveZipConfig): forcing it on for every target made `zip:all` build the same
    // archive twice, the second run overwriting the first under this one name.
    sourcesTemplate: "{{name}}-v{{version}}-sources.zip",
    // Keep the AMO source archive to actual build inputs - drop build/test artifacts so a
    // reviewer gets sources + lockfile only (they run the build themselves).
    excludeSources: [".env", ".env.*", ".output/**", "test-results/**", "e2e/test-results/**", "playwright-report/**", "coverage/**", ".playwright/**", ".playwright-mcp/**", "assets/**", "**/*.zip"],
  },
  hooks: {
    // Lift the source maps out of the artifact before it is zipped; see
    // docs/releasing.md for where they go and why they are kept.
    "build:done": async (wxt, output) => {
      if (wxt.config.command !== "build") return;
      const target = basename(wxt.config.outDir);
      const destination = resolve(wxt.config.outBaseDir, "sourcemaps", target, output.manifest.version);
      for await (const relativePath of glob("**/*.map", { cwd: wxt.config.outDir })) {
        const to = resolve(destination, relativePath);
        await mkdir(dirname(to), { recursive: true });
        await rename(resolve(wxt.config.outDir, relativePath), to);
      }
      // WXT prints its size table from this in-memory list AFTER the hook, so every
      // map moved above would be lstat'ed where it no longer is - one
      // "Could not get stats of ... .js.map" warning per bundle, then a table row
      // with a blank size. Drop them so the summary describes the real directory.
      forgetSourcemaps(output.publicAssets);
      for (const step of output.steps) forgetSourcemaps(step.chunks);
    },
  },
});
