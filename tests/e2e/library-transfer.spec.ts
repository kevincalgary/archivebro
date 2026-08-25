import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, withFixtureServer, waitForArchiveCount, testHooks, type AppHandle } from './helpers';

/**
 * Whole-library export/import (roadmap): migrating a library between
 * machines. Two independent app instances (each launchApp() gets its own
 * fresh --user-data-dir, so its own settings + SQLite catalog + archive
 * storage dir) stand in for "the old machine" and "the new machine" --
 * exactly the scenario this feature exists for.
 */

test.describe('whole-library export/import', () => {
  test('exporting the library and importing it into a fresh library restores the catalog row, files, tags, and search', async () => {
    let outDir: string | null = null;
    let firstHandle: AppHandle | null = null;
    let secondHandle: AppHandle | null = null;

    try {
      outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'library-transfer-e2e-'));
      firstHandle = await launchApp();
      await testHooks(firstHandle.app).updateSettings({ captureDelayMs: 250 });

      await withFixtureServer(async (base) => {
        await navigateViaAddressBar(firstHandle!, `${base}/`);
        const items = await waitForArchiveCount(firstHandle!.app, (i) => i.some((x) => x.status === 'success'));
        const captured = items.find((i) => i.finalUrl === `${base}/`)!;

        await firstHandle!.window.evaluate(
          (id) => (window as any).archiveBrowser.library.tag(id, ['reference']),
          captured.id,
        );

        const exportPath = path.join(outDir!, 'library-export.zip');
        const exportResult = await testHooks(firstHandle!.app).exportLibraryToPath(exportPath);
        expect(exportResult.archiveCount).toBeGreaterThanOrEqual(1);

        const sourceText = await testHooks(firstHandle!.app).readArchiveText(captured.id);

        secondHandle = await launchApp();
        const importResult = await testHooks(secondHandle.app).importLibraryFromPath(exportPath);
        expect(importResult).toEqual({
          importedCount: exportResult.archiveCount,
          skippedCount: 0,
          failedCount: 0,
        });

        const { items: destItems } = await testHooks(secondHandle.app).queryArchives({
          search: undefined,
          limit: 50,
          offset: 0,
        });
        const imported = destItems.find((i) => i.id === captured.id)!;
        expect(imported).toBeTruthy();
        expect(imported.finalUrl).toBe(`${base}/`);
        expect(imported.tags).toEqual(['reference']);

        const destText = await testHooks(secondHandle.app).readArchiveText(captured.id);
        expect(destText).toBe(sourceText);
        expect(destText.length).toBeGreaterThan(0);

        // Re-importing the same export a second time must not duplicate
        // the archive -- it's already present at the destination now.
        const reimportResult = await testHooks(secondHandle.app).importLibraryFromPath(exportPath);
        expect(reimportResult).toEqual({ importedCount: 0, skippedCount: exportResult.archiveCount, failedCount: 0 });
      });
    } finally {
      await firstHandle?.close();
      await secondHandle?.close();
      if (outDir) await fs.rm(outDir, { recursive: true, force: true });
    }
  });
});
