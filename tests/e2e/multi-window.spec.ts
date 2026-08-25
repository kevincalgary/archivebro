import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  launchApp,
  navigateViaAddressBar,
  testHooks,
  waitForAnotherTrustedWindow,
  waitForTabs,
  type AppHandle,
} from './helpers';
import { withSiteFixture, siteHooks, currentPageScope } from './sitearchive-helpers';

/**
 * True multi-window support (roadmap): each app window owns an independent
 * TabManager, so tabs never leak between windows, and a running
 * .sitearchive capture is hosted on a dedicated hidden window rather than
 * whichever chrome window started it -- see the design notes in
 * src/main/windows/appWindow.ts and captureHostWindow.ts.
 */

let handle: AppHandle;

/** Polls window A's own tab list (via its own IPC, not the ambiguous-under-multi-window test hook) for a tab whose URL has started with urlPrefix. */
async function waitForFirstWindowTab(urlPrefix: string, timeoutMs = 10_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tabs = (await handle.window.evaluate(() => (window as any).archiveBrowser.tabs.list())) as Array<{
      id: string;
      url: string;
    }>;
    const match = tabs.find((tab) => tab.url.startsWith(urlPrefix));
    if (match) return match.id;
    if (Date.now() > deadline) return undefined;
    await handle.window.waitForTimeout(200);
  }
}

test.beforeEach(async () => {
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test.describe('multiple windows', () => {
  test('File > New Window (via test hook) opens a second, independent window with its own blank tab', async () => {
    const hooks = testHooks(handle.app);
    await hooks.createWindowForTesting();
    const second = await waitForAnotherTrustedWindow(handle.app, [handle.window]);
    await second.waitForLoadState('domcontentloaded');

    await expect(second.locator('.tab')).toHaveCount(1);
    await expect(second.locator('.address-bar-input')).toBeEnabled();
  });

  test('tabs opened in one window do not appear in another', async () => {
    const hooks = testHooks(handle.app);
    await hooks.createWindowForTesting();
    const second = await waitForAnotherTrustedWindow(handle.app, [handle.window]);
    await second.waitForLoadState('domcontentloaded');

    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForFirstWindowTab(site.url);
      // New Tab has no toolbar button (only a File-menu accelerator); drive
      // it the same way that menu action does, via the exposed IPC.
      await second.evaluate(() => (window as any).archiveBrowser.tabs.create());

      const firstTabs = (await handle.window.evaluate(() => (window as any).archiveBrowser.tabs.list())) as Array<{
        url: string;
      }>;
      const secondTabs = (await second.evaluate(() => (window as any).archiveBrowser.tabs.list())) as Array<{
        url: string;
      }>;

      expect(firstTabs.some((t) => t.url.startsWith(site.url))).toBe(true);
      expect(secondTabs.some((t) => t.url.startsWith(site.url))).toBe(false);
      expect(secondTabs).toHaveLength(2);
      expect(firstTabs).toHaveLength(1);
    });
  });

  test('closing one window leaves the other fully functional', async () => {
    const hooks = testHooks(handle.app);
    await hooks.createWindowForTesting();
    const second = await waitForAnotherTrustedWindow(handle.app, [handle.window]);
    await second.waitForLoadState('domcontentloaded');

    await second.close();

    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (tabs) => tabs.some((t) => t.url.startsWith(site.url)));
    });
  });

  test('a capture started in one window keeps running after that window closes', async () => {
    const hooks = testHooks(handle.app);
    const siteHooksForFirst = siteHooks(handle.app);

    await hooks.createWindowForTesting();
    const second = await waitForAnotherTrustedWindow(handle.app, [handle.window]);
    await second.waitForLoadState('domcontentloaded');

    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      // navigateViaAddressBar only dispatches the navigation -- it doesn't
      // wait for it to land -- so wait for the tab's own URL to actually
      // reflect it before reading its id, or the capture below can start
      // against a tab still showing about:blank. Queried through window A's
      // own IPC (not the focus-dependent test-hook tabManager getter,
      // which would be ambiguous here with a second window also open).
      const tabId = await waitForFirstWindowTab(site.url);
      if (!tabId) throw new Error('No tab');

      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'multi-window-capture-'));
      try {
        await siteHooksForFirst.captureSiteToPath(tabId, currentPageScope(), path.join(outDir, 'A.sitearchive'));

        // Close the window that started the capture -- its tabs (and their
        // auto-archive bookkeeping) are torn down, but the capture itself
        // runs on the dedicated hidden capture-host window, not this one.
        await handle.window.close();

        const result = await siteHooksForFirst.awaitCapture();
        expect(result).not.toBeNull();
        expect(result?.pageCount ?? 0).toBeGreaterThan(0);
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    });
  });
});
