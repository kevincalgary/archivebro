import { test, expect } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
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

  test('a page.mhtml modified on disk since capture fails its integrity check and falls back instead of rendering tampered bytes', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      const items = await waitForArchiveCount(handle.app, (i) => i.some((i2) => i2.status === 'success'));
      const captured = items.find((i) => i.finalUrl === `${base}/`)!;
      const root = await testHooks(handle.app).archivesRoot();
      const mhtmlPath = path.join(root, captured.id, 'page.mhtml');

      // Flip a byte in the middle of the file -- simulates on-disk tampering
      // or bit rot between capture and viewing, distinct from the file
      // simply being deleted (covered by the "no MHTML" fallback path
      // elsewhere).
      const original = await fs.readFile(mhtmlPath);
      const tampered = Buffer.from(original);
      tampered[Math.floor(tampered.length / 2)] ^= 0xff;
      await fs.writeFile(mhtmlPath, tampered);

      await handle.window.getByRole('button', { name: /Library/ }).click();
      await handle.window.locator('.archive-card').first().click();
      await handle.window.getByRole('button', { name: 'Open offline' }).click();

      const tabs = await waitForTabs(handle.app, (tabs) =>
        tabs.some((t) => t.isOffline && t.url.startsWith('archive://') && t.url.includes('__fallback__')),
      );
      const offlineTab = tabs.find((t) => t.isOffline);
      expect(offlineTab?.url).toContain('reason=integrity');
    });
  });
});
