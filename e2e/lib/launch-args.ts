// SPDX-License-Identifier: GPL-3.0-or-later
//
// The Chrome command line every extension-loading run needs.
//
// A LEAF module: external tooling resolves this file via EM_EXT_ROOT and loads it
// directly under plain Node, so no relative imports, nothing outside node:*, and
// keep the export shape stable.

interface ExtensionLaunchArgOptions {
  /** Unpacked extension folders to load (backslashes are normalized here). */
  extensionPaths: string[];
  /** Adds --lang=<locale>. Omit to leave Chrome on its own UI language. */
  locale?: string;
  /** Adds --window-size=<size>, e.g. "1366,900". */
  windowSize?: string;
  incognito?: boolean;
  /** Hide the automation flag (navigator.webdriver=false) so sites don't serve a
   *  degraded page or bot challenge. Defaults to E2E_REALISTIC_CLIENT. */
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
    // Emojery runs NO scan while document.hidden (src/adapters/scan-observer.ts), so a
    // tab Chrome considers hidden mounts nothing at all. Windows occlusion tracking
    // marks every tab of a covered window hidden, which on a normal desktop - the run
    // behind an editor or a terminal - turns the whole suite into "no host on any site".
    // These keep the window manager from deciding what a headed run measures.
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "--no-default-browser-check",
    "--no-first-run",
    ...(options.locale ? [`--lang=${options.locale}`] : []),
    ...(options.windowSize ? [`--window-size=${options.windowSize}`] : []),
    ...((options.realisticClient ?? realisticClientEnabled()) ? ["--disable-blink-features=AutomationControlled"] : []),
  ];
}
