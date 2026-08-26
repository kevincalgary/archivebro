import { test, expect } from '@playwright/test';
import { launchApp, navigateViaAddressBar, withFixtureServer, testHooks, type AppHandle } from './helpers';

test.describe('domain exclusions and private browsing', () => {
  let handle: AppHandle;

  test.beforeEach(async () => {
    handle = await launchApp();
    await testHooks(handle.app).updateSettings({ captureDelayMs: 250 });
  });

  test.afterEach(async () => {
    await handle.close();
  });

  test('an excluded domain is never archived', async () => {
    await withFixtureServer(async (base) => {
      const domain = new URL(base).hostname;
      await testHooks(handle.app).updateSettings({ excludedDomains: [domain] });

      await navigateViaAddressBar(handle, `${base}/`);
      await handle.window.waitForTimeout(1500); // longer than the capture delay, to prove nothing gets written

      const { items } = await testHooks(handle.app).queryArchives({ sort: 'newest', limit: 50, offset: 0 });
      expect(items.some((i) => i.finalUrl === `${base}/`)).toBe(false);
    });
  });

  test('turning off automatic archiving in Settings actually stops captures', async () => {
    await withFixtureServer(async (base) => {
      await testHooks(handle.app).updateSettings({ autoCaptureEnabled: false });

      await navigateViaAddressBar(handle, `${base}/`);
      await handle.window.waitForTimeout(1500); // longer than the capture delay, to prove nothing gets written

      const { items } = await testHooks(handle.app).queryArchives({ sort: 'newest', limit: 50, offset: 0 });
      expect(items.some((i) => i.finalUrl === `${base}/`)).toBe(false);
    });
  });

  test('pausing automatic archiving on a tab stops captures for that tab', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await handle.window.waitForTimeout(200);
      // "Pause archiving" toggle button in the toolbar.
      await handle.window.getByRole('button', { name: /Archiving/ }).click();

      await navigateViaAddressBar(handle, `${base}/page-two`);
      await handle.window.waitForTimeout(1500);

      const { items } = await testHooks(handle.app).queryArchives({ sort: 'newest', limit: 50, offset: 0 });
      expect(items.some((i) => i.finalUrl === `${base}/page-two`)).toBe(false);
    });
  });

  test('a private tab is never archived and leaves no trace after it is closed', async () => {
    await withFixtureServer(async (base) => {
      await handle.window.getByRole('button', { name: /Private/ }).click();
      await handle.window.waitForTimeout(300);

      const tabsBefore = await testHooks(handle.app).listTabs();
      const privateTab = tabsBefore.find((t) => t.isPrivate);
      expect(privateTab).toBeTruthy();

      await navigateViaAddressBar(handle, `${base}/`);
      await handle.window.waitForTimeout(1500);

      const { items } = await testHooks(handle.app).queryArchives({ sort: 'newest', limit: 50, offset: 0 });
      expect(items.some((i) => i.finalUrl === `${base}/`)).toBe(false);

      // Closing the private tab leaves nothing behind for a future session
      // to pick up (no archive rows, regardless of tab lifecycle).
      const closeButtons = handle.window.locator('.tab-close');
      await closeButtons.last().click();
      await handle.window.waitForTimeout(200);
      const { items: afterClose } = await testHooks(handle.app).queryArchives({ sort: 'newest', limit: 50, offset: 0 });
      expect(afterClose.some((i) => i.finalUrl === `${base}/`)).toBe(false);
    });
  });
});
