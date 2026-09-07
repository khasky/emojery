// SPDX-License-Identifier: GPL-3.0-or-later
//
// Moving a reaction history between browsers: the Account tab's Export writes a
// real file through the browser's download path, and Import REPLACES the stored
// rows with that file's contents. Component tests already cover the confirm
// panel's numbers and the disabled states (popup-history-data.browser.test.tsx);
// what only a browser can show is the download itself, a file picked off disk,
// and what the background's IndexedDB holds afterwards.
//
// The rows written here are a modified copy of the account's OWN export, so the
// import is fed a file the extension could have produced - never a hand-invented
// shape that would pass the parser and lie about the schema.
import { readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { HISTORY_EXPORT_SCHEMA_VERSION, type HistoryExportFile, type PortableHistoryRow } from "../src/shared/messages";
import * as ext from "./lib/extension";
import { expectLatestHistoryReactions } from "./lib/popup-probes";
import { DATA_FILE_SELECTOR, DATA_STATUS_SELECTOR, IMPORT_CONFIRM_COUNT_SELECTOR, IMPORT_CONFIRM_SELECTOR } from "./lib/selectors";

const REQUIRES_OTP = ext.otpSkipReason("the history export/import round-trip");

// The whole file drives the popup's Account tab, which Playwright Firefox cannot reach.
test.skip(ext.isFirefoxRun(), ext.FIREFOX_NO_EXTENSION_PAGES);

async function openAccountTab(context: ext.Session["context"]): Promise<Page> {
  const popup = await ext.openPopup(context);
  await popup.getByRole("tab", { name: "Account" }).click();
  await expect(popup.locator(DATA_FILE_SELECTOR), "the Account tab should offer the import control").toBeAttached();
  return popup;
}

// Read through the background's own channel rather than the rendered list: the
// History view loads once and would snapshot whatever was there before the write.
async function storedReactions(popup: Page): Promise<string[]> {
  return popup.evaluate(() => chrome.runtime.sendMessage({ type: "history:page", limit: 50 }).then((resp: { items?: Array<{ reaction?: string }> } | undefined) => (resp?.items ?? []).map((row) => row.reaction ?? "")));
}

test("history export writes a real file, and importing it back replaces the stored rows", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    const page = await ext.signedInGithubPage(session.context);
    await ext.clearReaction(page);
    await expect.poll(() => ext.hasOwnReaction(page), { message: "the clear should land before the case reacts again" }).toBe(false);
    await ext.reactWith(page, ext.REACTIONS.heart);
    // The vote reaches history only after the server confirms it, so wait on the
    // settled row before asking for an export of it.
    await expectLatestHistoryReactions(session.context, [ext.REACTIONS.heart]);

    const popup = await openAccountTab(session.context);
    try {
      const downloaded = popup.waitForEvent("download");
      await popup.getByRole("button", { name: "Export", exact: true }).click();
      const download = await downloaded;
      expect(download.suggestedFilename(), "the export is named for the day it was taken").toMatch(/^emojery-history-\d{4}-\d{2}-\d{2}\.json$/);

      const exportPath = test.info().outputPath("emojery-history-export.json");
      await download.saveAs(exportPath);
      const exported = JSON.parse(readFileSync(exportPath, "utf8")) as HistoryExportFile;
      expect(exported.format, "the magic marker is what lets an import trust the file").toBe("emojery-history");
      expect(exported.schemaVersion).toBe(HISTORY_EXPORT_SCHEMA_VERSION);
      expect(exported.app.name).toBe("Emojery");
      const source = exported.reactions.at(-1);
      expect(source, "the reaction just cast should be in the export").toBeDefined();
      if (!source) throw new Error("empty export");
      expect(source.reaction).toBe(ext.REACTIONS.heart);
      expect(source.site).toBe("github");
      expect(source.targetUrl).toMatch(/^https?:\/\//);

      // A DIFFERENT history, built from the exported row: two rows, the newer one
      // carrying a reaction the account never cast. Anything less could pass while
      // the import quietly kept the rows already there.
      const rows: PortableHistoryRow[] = [
        { ...source, reaction: ext.REACTIONS.heart, ts: source.ts - 60_000 },
        { ...source, reaction: ext.REACTIONS.fire, ts: source.ts - 30_000 },
      ];
      const importPath = test.info().outputPath("emojery-history-import.json");
      writeFileSync(importPath, JSON.stringify({ ...exported, reactions: rows }));

      const storedBefore = await storedReactions(popup);
      await popup.locator(DATA_FILE_SELECTOR).setInputFiles(importPath);
      await expect(popup.locator(IMPORT_CONFIRM_SELECTOR), "a replacing import must arm a confirm first").toBeVisible();
      await expect(popup.locator(IMPORT_CONFIRM_COUNT_SELECTOR)).toHaveText(`${storedBefore.length} → ${rows.length}`);

      await popup.getByRole("button", { name: "Cancel" }).click();
      await expect(popup.locator(IMPORT_CONFIRM_SELECTOR)).toHaveCount(0);
      expect(await storedReactions(popup), "a cancelled import must leave the stored history alone").toEqual(storedBefore);

      await popup.locator(DATA_FILE_SELECTOR).setInputFiles(importPath);
      await expect(popup.locator(IMPORT_CONFIRM_SELECTOR)).toBeVisible();
      await popup.getByRole("button", { name: "Replace" }).click();
      await expect(popup.locator(DATA_STATUS_SELECTOR)).toHaveText(ext.enMessage("importDone", String(rows.length)));

      await expect.poll(() => storedReactions(popup), { message: "the imported file's rows should replace the account's history, newest first" }).toEqual([ext.REACTIONS.fire, ext.REACTIONS.heart]);
    } finally {
      await popup.close().catch(() => {});
    }
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});

test("a file that is not an Emojery export is refused before anything is stored", async () => {
  test.skip(!ext.authConfigured(), REQUIRES_OTP);
  const session = await ext.launchSession();
  try {
    await ext.signIn(session.context);
    const popup = await openAccountTab(session.context);
    try {
      const junkPath = test.info().outputPath("not-an-emojery-export.json");
      writeFileSync(junkPath, JSON.stringify({ format: "someone-elses-backup", reactions: [{ reaction: "🔥" }] }));

      await popup.locator(DATA_FILE_SELECTOR).setInputFiles(junkPath);
      await expect(popup.locator(DATA_STATUS_SELECTOR)).toHaveText(ext.enMessage("importError"));
      await expect(popup.locator(IMPORT_CONFIRM_SELECTOR), "a refused file must not arm the replace confirm").toHaveCount(0);
      expect(await storedReactions(popup), "a refused file must not write anything").toEqual([]);
    } finally {
      await popup.close().catch(() => {});
    }
  } finally {
    await ext.ensureSignedOut(session.context).catch(() => {});
    await ext.closeSession(session);
  }
});
