import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, withFixtureServer, waitForArchiveCount, testHooks, type AppHandle } from './helpers';

test.describe('library deletion', () => {
  let handle: AppHandle;

  test.beforeEach(async () => {
    handle = await launchApp();
    await testHooks(handle.app).updateSettings({ captureDelayMs: 250 });
  });

  test.afterEach(async () => {
    await handle.close();
  });

  test('deleting an archive removes both the catalog row and the files on disk', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      const items = await waitForArchiveCount(handle.app, (items) => items.some((i) => i.status === 'success'));
      const captured = items.find((i) => i.finalUrl === `${base}/`)!;
      const root = await testHooks(handle.app).archivesRoot();
      const dir = path.join(root, captured.id);

      await expect.poll(async () => fs.stat(dir).then(() => true).catch(() => false)).toBe(true);

      await handle.window.evaluate(
        (id) => (window as any).archiveBrowser.library.delete(id),
        captured.id,
      );

      const { items: after } = await testHooks(handle.app).queryArchives({ sort: 'newest', limit: 50, offset: 0 });
      expect(after.some((i) => i.id === captured.id)).toBe(false);
      await expect.poll(async () => fs.stat(dir).then(() => true).catch(() => false)).toBe(false);
    });
  });

  test('deleting all archives for a domain removes every version for that domain', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.finalUrl === `${base}/`));
      await navigateViaAddressBar(handle, `${base}/page-two`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.finalUrl === `${base}/page-two`));

      const domain = new URL(base).hostname;
      await handle.window.evaluate(
        (d) => (window as any).archiveBrowser.library.deleteByDomain(d),
        domain,
      );

      const { items } = await testHooks(handle.app).queryArchives({ sort: 'newest', limit: 50, offset: 0 });
      expect(items.some((i) => i.domain === domain)).toBe(false);
    });
  });
});
