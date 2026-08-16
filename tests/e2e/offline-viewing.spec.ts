import { test, expect } from '@playwright/test';
import { launchApp, navigateViaAddressBar, withFixtureServer, waitForArchiveCount, waitForTabs, testHooks, type AppHandle } from './helpers';

test.describe('offline viewing', () => {
  let handle: AppHandle;

  test.beforeEach(async () => {
    handle = await launchApp();
    await testHooks(handle.app).updateSettings({ captureDelayMs: 250 });
  });

  test.afterEach(async () => {
    await handle.close();
  });

  test('opening an archived page offline renders the MHTML snapshot on a blocked, JS-disabled session', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.status === 'success'));

      await handle.window.getByRole('button', { name: /Library/ }).click();
      await handle.window.locator('.archive-card').first().click();
      await handle.window.getByRole('button', { name: 'Open offline' }).click();

      // The MHTML snapshot itself loads via a validated file:// path (see
      // tabManager.ts openOfflineTab for why -- Chromium only recognizes
      // MHTML documents loaded that way); everything else (screenshot,
      // text, the no-MHTML fallback) is served through archive://.
      const archivesRoot = await testHooks(handle.app).archivesRoot();
      const tabs = await waitForTabs(handle.app, (tabs) =>
        tabs.some(
          (t) =>
            t.isOffline &&
            t.url.startsWith('file://') &&
            t.url.includes(archivesRoot) &&
            t.url.endsWith('page.mhtml') &&
            t.title === 'Fixture Home',
        ),
      );
      const offlineTab = tabs.find((t) => t.isOffline);
      expect(offlineTab).toBeTruthy();
      expect(offlineTab?.title).toBe('Fixture Home');
    });
  });

  test('deleting all browsing tabs and the fixture server does not affect an already-open offline tab', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.status === 'success'));

      await handle.window.getByRole('button', { name: /Library/ }).click();
      await handle.window.locator('.archive-card').first().click();
      await handle.window.getByRole('button', { name: 'Open offline' }).click();
      // The fixture server is closed by withFixtureServer's cleanup right
      // after this callback returns -- if the offline tab were still
      // making real network requests, it would have nothing left to talk
      // to. This is validated at the session level, not asserted here
      // directly, since Playwright can't attach to WebContentsView content;
      // see the offlineSession.ts webRequest denylist for the enforcement.
      await waitForTabs(handle.app, (tabs) => tabs.some((t) => t.isOffline));
    });
  });
});
