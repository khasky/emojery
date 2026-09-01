// SPDX-License-Identifier: GPL-3.0-or-later
//
// chrome.storage.*.get honours four key shapes: null/undefined (all), a string,
// an array, or a defaults object (whose keys are read). Shared by the jsdom
// fixture (./fixtures.ts) and the browser-mode shim (./chrome-shim.ts).
export function storageGetKeys(allKeys: Iterable<string>, keys: unknown): string[] {
  if (typeof keys === "string") return [keys];
  if (Array.isArray(keys)) return keys as string[];
  if (keys && typeof keys === "object") return Object.keys(keys as object);
  return [...allKeys];
}
