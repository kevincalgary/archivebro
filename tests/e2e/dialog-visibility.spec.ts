import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope, siteScope } from './sitearchive-helpers';

/**
 * Regression tests for a bug that DOM-level assertions cannot catch.
 *
 * Tab content is a native WebContentsView composited on top of the
 * window's HTML. A dialog can therefore be perfectly "visible" to
 * Playwright (present, displayed, non-zero box) while being completely
 * hidden from the user behind the live web page.
 *
 * The only reliable signal is the native view's own bounds: if it still
 * covers the window while a modal is open, the user cannot see that modal.
 */

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dialog-vis-'));
});

test.afterEach(async () => {
  await handle.close();
  await fs.rm(outDir, { recursive: true, force: true });
});

async function activeTabId(): Promise<string> {
  const tabs = await siteHooks(handle.app).listTabs();
  const id = tabs[0]?.id;
  if (!id) throw new Error('No tab');
  return id;
}

test.describe('dialogs are actually visible, not hidden behind the page', () => {
  test('the page covers the window during normal browsing', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      // Baseline: with no dialog open the web page should fill the content
      // area, otherwise the rest of these assertions would be meaningless.
      await expect
        .poll(async () => (await siteHooks(handle.app).contentBounds()).height, { timeout: 10_000 })
        .toBeGreaterThan(0);
    });
  });

  test('opening the capture scope dialog uncovers the window', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);
      expect((await siteHooks(handle.app).contentBounds()).height).toBeGreaterThan(0);

      await handle.window.getByRole('button', { name: 'Capture the Page' }).click();
      await expect(handle.window.getByRole('dialog', { name: 'Capture the Page' })).toBeVisible();

      // The native page view must collapse, or this dialog is painted over.
      await expect
        .poll(async () => (await siteHooks(handle.app).contentBounds()).height, { timeout: 10_000 })
        .toBe(0);
    });
  });

  test('closing the scope dialog restores the page', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const dialogButton = handle.window.getByRole('button', { name: 'Capture the Page' });
      await dialogButton.click();
      const dialog = handle.window.getByRole('dialog', { name: 'Capture the Page' });
      await expect(dialog).toBeVisible();
      await expect.poll(async () => (await siteHooks(handle.app).contentBounds()).height).toBe(0);

      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();

      // Cancelling must give the page back, not leave a blank window.
      await expect
        .poll(async () => (await siteHooks(handle.app).contentBounds()).height, { timeout: 10_000 })
        .toBeGreaterThan(0);
    });
  });

  test('the capture progress dialog is uncovered for its whole lifetime', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const hooks = siteHooks(handle.app);
      const out = path.join(outDir, 'Vis.sitearchive');
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 1, maxPages: 5, crawlDelayMs: 300 }), out);

      await expect(handle.window.getByRole('dialog', { name: 'Capture progress' })).toBeVisible();
      // Hidden while running...
      await expect.poll(async () => (await hooks.contentBounds()).height, { timeout: 10_000 }).toBe(0);

      await hooks.awaitCapture();

      // ...and still hidden at the completion summary, which is exactly
      // the screen the user needs to read and act on.
      await expect(handle.window.getByText('Capture complete')).toBeVisible({ timeout: 15_000 });
      expect((await hooks.contentBounds()).height).toBe(0);
    });
  });

  test('dismissing the completion summary restores the page', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const hooks = siteHooks(handle.app);
      const out = path.join(outDir, 'Restore.sitearchive');
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const dialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await expect(dialog.getByText('Capture complete')).toBeVisible({ timeout: 15_000 });
      await dialog.getByRole('button', { name: 'Close', exact: true }).click();

      await expect
        .poll(async () => (await hooks.contentBounds()).height, { timeout: 10_000 })
        .toBeGreaterThan(0);
    });
  });
});
