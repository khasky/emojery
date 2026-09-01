// SPDX-License-Identifier: GPL-3.0-or-later
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Vitest's default replaces every `.css` import with an empty string -
    // INCLUDING `?raw`, which is how the picker's stylesheet reaches the shadow
    // root (ui/mount-shadow.ts). Left off, PICKER_STYLESHEET is silently missing
    // picker.css here and any assertion on its text passes against nothing.
    // Measured at no cost to this suite's runtime.
    css: true,
    // scripts/ too, so build-script tests land in this suite.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx", "scripts/**/*.test.mjs"],
    setupFiles: ["./src/test/setup.ts"],
    // Browser-mode specs (*.browser.test.*) run under vitest.browser.config.ts
    // in real WebKit, not jsdom - keep them out of this fast unit suite.
    exclude: [...configDefaults.exclude, "**/*.browser.test.*"],
    globals: false,
    // No global testTimeout override: vitest's 5s default is the hang detector, and
    // widening it repo-wide costs every millisecond-fast file 4x slower feedback on a
    // real hang. The files that genuinely need more - the ones whose `vi.resetModules()`
    // puts a cold module-graph transform inside the timed body - raise it themselves
    // via src/test/cold-module-reset.ts, whose header says how to list them.
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "text"],
      // Whole directories, so new files are measured by default and an
      // exemption has to be argued for in `exclude`.
      include: ["src/adapters/**/*.ts", "src/background/**/*.ts", "src/shared/**/*.ts", "src/entrypoints/**/*.ts", "src/entrypoints/**/*.tsx", "src/ui/**/*.ts", "src/ui/**/*.tsx"],
      exclude: [
        "**/*.test.ts",
        "**/*.test.tsx",
        "src/test/**",
        // e2e-owned live-page orchestration:
        "src/ui/content-entry.ts",
        // Excluding a whole file also hides whatever pure logic sits in it, so the
        // struct-level half of mount.ts (which placement is live, is the mount still
        // on it) lives in the MEASURED mount-placement.ts. Keep that split when
        // adding to this file: if a new helper needs only a point and a plain
        // element, it belongs there, not here.
        "src/ui/mount.ts",
        // mount-style.ts joined them: spacing, row fit, native-slot margin
        // inheritance and glyph sizing are read off a real page's computed
        // styles, so the jsdom tests that covered them were a fake action row
        // in disguise and are gone. Same rule as mount.ts above - the decisions
        // that need only values (radius/padding/margin lengths, the readable-colour
        // snap) live in the MEASURED mount-style-math.ts; what stays here reads a
        // live box. Only the geometry-free readActionLayout contract is tested
        // against this file directly.
        "src/ui/mount-style.ts",
        // WXT registration stubs: a `defineContentScript` call and nothing
        // else. Their one contract - the literal match patterns WXT extracts
        // statically - is pinned by shared/content-matches.test.ts.
        "src/entrypoints/*.content.ts",
        // covered by the browser-mode suite (vitest.browser.config.ts), not jsdom:
        "src/ui/picker.tsx",
        "src/ui/picker-hooks.ts",
        "src/ui/picker-parts.tsx",
        "src/ui/emoji-img.tsx",
        "src/ui/emoji-sprite.ts",
        "src/ui/mount-shadow.ts",
        "src/entrypoints/popup/popup-emoji-sentiment.tsx",
        "src/entrypoints/popup/popup-history-data.tsx",
        "src/entrypoints/popup/popup-report.tsx",
        "src/entrypoints/popup/popup-settings.tsx",
        "src/entrypoints/popup/popup-slide-confirm.tsx",
        "src/entrypoints/popup/popup-tooltip.tsx",
        "src/entrypoints/popup/popup-history.tsx",
        "src/entrypoints/popup/popup-account.tsx",
        "src/entrypoints/onboarding/main.tsx",
        "src/entrypoints/auth/main.tsx",
        // Same rule: every popup view above imports this module's row/field/icon
        // shells, so the browser suite renders it on every one of its cases. Left
        // measured it reported 0% - the one reading in this table that was false in
        // the reassuring direction, since a 0% on a shared UI module invites a test
        // nobody needs.
        "src/entrypoints/popup/popup-shared.tsx",
        // The popup shell: tab markup, the view render switch, and the wiring that
        // hands `settings`/`update` to each view. Its decisions - which view a
        // stored value resolves to, how a settings patch merges, where an arrow key
        // lands - live in the MEASURED popup-view-state.ts. Keep that split when
        // adding here: anything that needs neither the DOM nor a rendered view
        // belongs in that module, not this one.
        "src/entrypoints/popup/main.tsx",
        // Staging-only diagnostics: `IS_STAGING_BUILD` folds to false in a
        // production build and this module drops out of the bundle with it.
        "src/entrypoints/popup/popup-queue.tsx",
        // Same rule, for the two background modules whose tests need a REAL
        // IndexedDB (history.browser.test.ts, votequeue.browser.test.ts): a 0%
        // here reads as "untested" rather than "tested by the other suite", and
        // 0% on two of the heaviest modules made the totals below useless as a gate.
        "src/background/history.ts",
        "src/background/votequeue.ts",
        // vendored brand-glyph path data (no logic to cover):
        "src/ui/brand-icons.ts",
      ],
      // No thresholds: the report is informational, coverage never fails a run.
    },
  },
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
    },
  },
});
