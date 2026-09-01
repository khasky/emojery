// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Chrome command line every extension-loading run needs.
//
// A LEAF module, and deliberately so: besides the e2e suites (through
// lib/extension.ts, which re-exports it) external tooling resolves this file
// via EM_EXT_ROOT and loads it directly under plain Node, where types are
// stripped at load and imports resolve by Node's own rules. So: no relative
// imports, nothing outside `node:*` - and keep the export shape stable. That
// single shared copy is what keeps a flag added for the suites from silently
// missing that tooling's launches.

interface ExtensionLaunchArgOptions {
  /** Unpacked extension folders to load (backslashes are normalized here). */
  extensionPaths: string[];
  /** Adds `--lang=<locale>`; omit to leave Chrome on its own UI language. */
  locale?: string;
  /** Adds `--window-size=<size>`, e.g. "1366,900". */
  windowSize?: string;
  incognito?: boolean;
  /** Hide the automation flag (navigator.webdriver=false) so sites don't serve a
   *  degraded page or bot challenge to a detected automated client. Defaults to
   *  the E2E_REALISTIC_CLIENT switch; pass `true` to force it on. */
  realisticClient?: boolean;
}

export function realisticClientEnabled(): boolean {
  return process.env.E2E_REALISTIC_CLIENT !== "0";
}

export function extensionLaunchArgs(options: ExtensionLaunchArgOptions): string[] {
  const paths = options.extensionPaths.map((path) => path.replace(/\\/g, "/")).join(",");
  return [
    ...(options.incognito ? ["--incognito"] : []),
    `--disable-extensions-except=${paths}`,
    `--load-extension=${paths}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--mute-audio",
    "--no-default-browser-check",
    "--no-first-run",
    ...(options.locale ? [`--lang=${options.locale}`] : []),
    ...(options.windowSize ? [`--window-size=${options.windowSize}`] : []),
    ...((options.realisticClient ?? realisticClientEnabled()) ? ["--disable-blink-features=AutomationControlled"] : []),
  ];
}
