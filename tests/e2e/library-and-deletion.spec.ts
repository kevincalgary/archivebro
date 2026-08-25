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

test.describe('library search ranking and snippets', () => {
  let handle: AppHandle;

  test.beforeEach(async () => {
    handle = await launchApp();
    await testHooks(handle.app).updateSettings({ captureDelayMs: 250 });
  });

  test.afterEach(async () => {
    await handle.close();
  });

  test('a title match ranks above a body-only match, and results carry a marked snippet', async () => {
    await withFixtureServer(async (base) => {
      // /search-rank-title's <title> contains the rare term; /search-rank-body's
      // does not -- it's only mentioned once in a paragraph. Visited in the
      // opposite order from what a relevance ranking should produce, so a
      // pass here can't be explained by the default newest-first sort.
      await navigateViaAddressBar(handle, `${base}/search-rank-body`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.finalUrl === `${base}/search-rank-body`));
      await navigateViaAddressBar(handle, `${base}/search-rank-title`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.finalUrl === `${base}/search-rank-title`));

      const { items } = await testHooks(handle.app).queryArchives({ search: 'zzyzxwidget', limit: 50, offset: 0 });
      const urls = items.map((i) => i.finalUrl);
      expect(urls.indexOf(`${base}/search-rank-title`)).toBeLessThan(urls.indexOf(`${base}/search-rank-body`));

      const bodyResult = items.find((i) => i.finalUrl === `${base}/search-rank-body`)!;
      expect(bodyResult.snippet).toContain('zzyzxwidget');

      const unfiltered = await testHooks(handle.app).queryArchives({ sort: 'newest', limit: 50, offset: 0 });
      expect(unfiltered.items.find((i) => i.finalUrl === `${base}/search-rank-body`)!.snippet).toBeNull();
    });
  });

  test('the Library screen renders the search snippet with the match highlighted', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/search-rank-body`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.finalUrl === `${base}/search-rank-body`));

      await handle.window.getByTitle('Library (Cmd/Ctrl+Shift+L)').click();
      await handle.window.locator('.library-search').fill('zzyzxwidget');

      const card = handle.window.locator('.archive-card', { hasText: 'Unrelated Title' });
      await expect(card.locator('.archive-card-snippet mark')).toHaveText('zzyzxwidget');
      await expect(handle.window.locator('.library-sort-note')).toHaveText('Sorted by relevance');
    });
  });
});
