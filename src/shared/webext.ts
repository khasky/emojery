// SPDX-License-Identifier: GPL-3.0-or-later
//
// Cross-browser WebExtension helpers. Firefox exposes promise APIs on
// `browser.*` and callbacks on `chrome.*`; Chromium MV3 mixes both. These
// wrappers always pass a callback and also accept a returned Promise, so
// runtime code and unit-test mocks work in both API shapes.

import { RUNTIME_MESSAGE_TIMEOUT_MS } from "./config";

// biome-ignore lint/suspicious/noConfusingVoidType: callback-style callers legitimately return nothing - void in the union is the point
type MaybePromise<T> = T | Promise<T> | void;

function isThenable<T>(value: MaybePromise<T>): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === "function";
}

// `lastError` is a getter, and on a content script whose extension context has been
// invalidated (the extension reloaded or updated under it) touching it THROWS. That
// must not escape into a Chrome callback: the caller's own error path would never
// run, and the page would be left with a half-finished mount. Unreadable reads as
// no error - there is no API answer to carry either way.
function runtimeError(): Error | null {
  try {
    const runtime = (
      globalThis as typeof globalThis & {
        chrome?: { runtime?: { lastError?: { message?: string } } };
      }
    ).chrome?.runtime;
    const err = runtime?.lastError;
    return err ? new Error(err.message ?? "extension API error") : null;
  } catch {
    return null;
  }
}

function callChrome<T>(invoke: (done: (value: T) => void) => MaybePromise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const done = (value: T) => {
      // Read lastError on EVERY callback, settled or not. Chrome only counts the
      // error as handled if the property is touched from inside the callback, and
      // logs "Unchecked runtime.lastError" on the extension's error page when it
      // is not - so a `done` that returns early on the second call leaves the real
      // callback's error unread. The fire-and-forget wrappers below settle this
      // promise before their API answers (`fn?.(..., cb) ?? done()` fires both, since
      // a callback-style Chrome API returns undefined), which makes that second
      // call the ordinary path: closing a tab mid-navigation logged one
      // "No tab with id" per toolbar paint.
      const err = runtimeError();
      if (settled) return;
      settled = true;
      if (err) {
        reject(err);
      } else {
        resolve(value);
      }
    };

    try {
      const returned = invoke(done);
      if (isThenable(returned)) {
        returned.then(done, reject);
      }
    } catch (err) {
      reject(err);
    }
  });
}

type StorageGetKeys = string | string[] | Record<string, unknown> | null;
type StorageRemoveKeys = string | string[];
type StorageItems = Record<string, unknown>;
type RuntimeMessage = import("./messages").RuntimeMessage;
type RuntimeResponse = import("./messages").RuntimeResponse;
export type DataCollectionPermissions = chrome.permissions.Permissions & {
  data_collection?: string[];
};
type PermissionsApi = {
  getAll?: (callback?: (permissions: DataCollectionPermissions) => void) => MaybePromise<DataCollectionPermissions>;
  request?: (permissions: DataCollectionPermissions, callback?: (granted: boolean) => void) => MaybePromise<boolean>;
  remove?: (permissions: DataCollectionPermissions, callback?: (removed: boolean) => void) => MaybePromise<boolean>;
};

function permissionsApi(): PermissionsApi {
  return (
    (
      globalThis as typeof globalThis & {
        chrome?: { permissions?: PermissionsApi };
      }
    ).chrome?.permissions ?? {}
  );
}

export function storageLocalGet(keys: StorageGetKeys): Promise<StorageItems> {
  return callChrome<StorageItems>((done) => chrome.storage.local.get(keys, (items) => done(items as StorageItems)));
}

export function storageLocalSet(items: StorageItems): Promise<void> {
  return callChrome<void>((done) => chrome.storage.local.set(items, () => done()));
}

export function storageLocalRemove(keys: StorageRemoveKeys): Promise<void> {
  return callChrome<void>((done) => chrome.storage.local.remove(keys, () => done()));
}

// Key list without the values. `getKeys` (Chrome 130+) exists precisely so a caller that
// only needs names doesn't pull the whole store into memory; older engines fall back to
// `get(null)`, which does.
export async function storageLocalGetKeys(): Promise<string[]> {
  const area = chrome.storage.local as chrome.storage.LocalStorageArea & {
    getKeys?: (callback?: (keys: string[]) => void) => MaybePromise<string[]>;
  };
  if (typeof area.getKeys === "function") {
    // No `?? done([])` fallback: a callback-style Chrome API returns undefined, so the
    // fallback would resolve the promise empty before the real callback ever fired.
    return callChrome<string[]>((done) => area.getKeys?.((keys) => done(keys)));
  }
  return Object.keys(await storageLocalGet(null));
}

export function storageSyncGet(keys: StorageGetKeys): Promise<StorageItems> {
  return callChrome<StorageItems>((done) => chrome.storage.sync.get(keys, (items) => done(items as StorageItems)));
}

export function storageSyncSet(items: StorageItems): Promise<void> {
  return callChrome<void>((done) => chrome.storage.sync.set(items, () => done()));
}

// storage.session defaults to a TRUSTED_CONTEXTS access level, so content scripts
// cannot read it - the home for a short-lived value that must stay off third-party
// hosts. It is cleared when the browser fully closes.
export function storageSessionGet(keys: StorageGetKeys): Promise<StorageItems> {
  return callChrome<StorageItems>((done) => chrome.storage.session.get(keys, (items) => done(items as StorageItems)));
}

export function storageSessionSet(items: StorageItems): Promise<void> {
  return callChrome<void>((done) => chrome.storage.session.set(items, () => done()));
}

export function storageSessionRemove(keys: StorageRemoveKeys): Promise<void> {
  return callChrome<void>((done) => chrome.storage.session.remove(keys, () => done()));
}

export function setUninstallURL(url: string): Promise<void> {
  return callChrome<void>((done) => chrome.runtime.setUninstallURL(url, () => done()));
}

export function createTab(details: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab> {
  return callChrome<chrome.tabs.Tab>((done) => chrome.tabs.create(details, done));
}

export function queryTabs(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> {
  return callChrome<chrome.tabs.Tab[]>((done) => chrome.tabs.query(queryInfo, done));
}

// MV3 injects a whole file list in one call; the Firefox MV2 build only has the
// deprecated tabs.executeScript, which takes one file at a time.
export async function executeScriptFiles(tabId: number, files: string[]): Promise<void> {
  if (chrome.scripting?.executeScript) {
    await callChrome<unknown>((done) => chrome.scripting.executeScript({ target: { tabId }, files }, done));
    return;
  }
  for (const file of files) {
    await callChrome<unknown>((done) => chrome.tabs.executeScript(tabId, { file }, done));
  }
}

export async function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  const tabs = await queryTabs({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

// Resolves to null when the tab is gone (get rejects via lastError). The returned
// tab's `url` is populated only when the extension holds host permission for it.
export function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  return callChrome<chrome.tabs.Tab | null>((done) => chrome.tabs.get(tabId, (tab) => done(tab ?? null))).catch(() => null);
}

// Bounded by a deadline: a background handler that never calls sendResponse (a service
// worker evicted mid-request, a downstream fetch that hangs) would otherwise leave the
// caller's promise - and everything it holds - pending for the life of the page.
export function sendRuntimeMessage(msg: RuntimeMessage): Promise<RuntimeResponse | undefined> {
  return withDeadline(
    callChrome<RuntimeResponse | undefined>((done) => chrome.runtime.sendMessage(msg, (response) => done(response))),
    RUNTIME_MESSAGE_TIMEOUT_MS,
    `runtime message timed out: ${msg.type}`,
  );
}

function withDeadline<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

// One guard for the three wrappers below: chrome.permissions (or the method) can be
// absent, in which case the call resolves to the caller's fallback instead of throwing.
function permissionsCall<T>(invoke: ((done: (value: T) => void) => MaybePromise<T>) | undefined, fallback: T): Promise<T> {
  return invoke ? callChrome<T>(invoke) : Promise.resolve(fallback);
}

export function permissionsGetAll(): Promise<DataCollectionPermissions | null> {
  const { getAll } = permissionsApi();
  return permissionsCall<DataCollectionPermissions | null>(getAll && ((done) => getAll((granted) => done(granted))), null);
}

export function permissionsRequest(permissionsToRequest: DataCollectionPermissions): Promise<boolean> {
  const { request } = permissionsApi();
  return permissionsCall<boolean>(request && ((done) => request(permissionsToRequest, done)), false);
}

export function permissionsRemove(permissionsToRemove: DataCollectionPermissions): Promise<boolean> {
  const { remove } = permissionsApi();
  return permissionsCall<boolean>(remove && ((done) => remove(permissionsToRemove, done)), false);
}

// Background to a specific tab's content script. Rejects (via lastError) when the
// tab has no receiver - callers fan out to many tabs and swallow that per-tab.
export function sendMessageToTab(tabId: number, msg: unknown): Promise<unknown> {
  return callChrome<unknown>((done) => chrome.tabs.sendMessage(tabId, msg, (response) => done(response)));
}

type AlarmsApi = {
  create?: (name: string, alarmInfo: chrome.alarms.AlarmCreateInfo, callback?: () => void) => MaybePromise<void>;
  clear?: (name: string, callback?: (wasCleared: boolean) => void) => MaybePromise<boolean>;
  onAlarm?: {
    addListener?: typeof chrome.alarms.onAlarm.addListener;
  };
};

function alarmsApi(): AlarmsApi {
  return (chrome as typeof chrome & { alarms?: AlarmsApi }).alarms ?? {};
}

export function createAlarm(name: string, alarmInfo: chrome.alarms.AlarmCreateInfo): void {
  const alarms = alarmsApi();
  void callChrome<void>((done) => alarms.create?.(name, alarmInfo, () => done()) ?? done()).catch(() => {});
}

export function clearAlarm(name: string): void {
  const alarms = alarmsApi();
  void callChrome<boolean>((done) => alarms.clear?.(name, (wasCleared) => done(wasCleared)) ?? done(false)).catch(() => {});
}

export function addAlarmListener(listener: Parameters<typeof chrome.alarms.onAlarm.addListener>[0]): void {
  alarmsApi().onAlarm?.addListener?.(listener);
}

type ToolbarAction = Pick<typeof chrome.action, "setBadgeText" | "setBadgeBackgroundColor" | "setBadgeTextColor" | "setIcon">;

function toolbarAction(): Partial<ToolbarAction> {
  const api = chrome as typeof chrome & {
    browserAction?: Partial<ToolbarAction>;
    action?: Partial<ToolbarAction>;
  };
  return api.action ?? api.browserAction ?? {};
}

type ToolbarDetails = chrome.action.BadgeTextDetails | chrome.action.BadgeColorDetails | chrome.action.TabIconDetails;

// Fire-and-forget for all four setters below: `?? done()` settles the callChrome
// promise on an engine that lacks the method, and a rejection (lastError on a
// closed tab) is swallowed - none of these are worth failing a caller over.
function callToolbar(method: keyof ToolbarAction, details: ToolbarDetails): void {
  // Cast because the four methods' overload sets are not callable as one union;
  // each exported setter below pins the details type for its own callers.
  const fn = toolbarAction()[method] as ((details: ToolbarDetails, callback: () => void) => void) | undefined;
  void callChrome<void>((done) => fn?.(details, () => done()) ?? done()).catch(() => {});
}

export function setToolbarBadgeText(details: chrome.action.BadgeTextDetails): void {
  callToolbar("setBadgeText", details);
}

export function setToolbarBadgeBackgroundColor(details: chrome.action.BadgeColorDetails): void {
  callToolbar("setBadgeBackgroundColor", details);
}

export function setToolbarBadgeTextColor(details: chrome.action.BadgeColorDetails): void {
  callToolbar("setBadgeTextColor", details);
}

export function setToolbarIcon(details: chrome.action.TabIconDetails): void {
  callToolbar("setIcon", details);
}

type ToolbarUserSettings = { isOnToolbar?: boolean };

// `null` when the engine has no getUserSettings (pre-91 Chromium, some forks) -
// callers treat that as "pin state unknowable" and keep their static fallback.
export function getToolbarUserSettings(): Promise<ToolbarUserSettings | null> {
  const api = chrome as typeof chrome & {
    browserAction?: { getUserSettings?: (callback?: (settings: ToolbarUserSettings) => void) => MaybePromise<ToolbarUserSettings> };
    action?: { getUserSettings?: (callback?: (settings: ToolbarUserSettings) => void) => MaybePromise<ToolbarUserSettings> };
  };
  const getUserSettings = api.action?.getUserSettings ?? api.browserAction?.getUserSettings;
  if (!getUserSettings) return Promise.resolve(null);
  return callChrome<ToolbarUserSettings>((done) => getUserSettings((settings) => done(settings))).catch(() => null);
}
