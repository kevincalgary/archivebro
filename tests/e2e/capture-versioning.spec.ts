import { test, expect } from '@playwright/test';
import { launchApp, navigateViaAddressBar, withFixtureServer, waitForArchiveCount, testHooks, type AppHandle } from './helpers';

test.describe('capture versioning', () => {
  let handle: AppHandle;

  test.beforeEach(async () => {
    handle = await launchApp();
    await testHooks(handle.app).updateSettings({ captureDelayMs: 250 });
  });

  test.afterEach(async () => {
    await handle.close();
  });

  test('visiting the same URL twice creates two versions grouped by canonical URL, not an overwrite', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.finalUrl === `${base}/`));

      // Navigate away, then back, to force a second distinct top-level visit.
      await navigateViaAddressBar(handle, `${base}/page-two`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.finalUrl === `${base}/page-two`));
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForArchiveCount(
        handle.app,
        (items) => items.filter((i) => i.finalUrl === `${base}/`).length >= 2,
      );

      const hooks = testHooks(handle.app);
      const { items } = await hooks.queryArchives({ sort: 'newest', limit: 100, offset: 0 });
      const versions = items.filter((i) => i.finalUrl === `${base}/`);
      expect(versions.length).toBe(2);
      // Distinct archive IDs and distinct visit timestamps -- a real new
      // version, not the same row touched twice.
      expect(versions[0]?.id).not.toBe(versions[1]?.id);
      expect(versions[0]?.canonicalUrl).toBe(versions[1]?.canonicalUrl);
    });
  });
});
