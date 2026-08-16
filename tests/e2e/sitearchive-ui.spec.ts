import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope } from './sitearchive-helpers';

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-ui-'));
});

test.afterEach(async () => {
  await handle.close();
  await fs.rm(outDir, { recursive: true, force: true });
});

test.describe('Capture the Page UI', () => {
  test('the toolbar shows a Capture the Page button', async () => {
    const button = handle.window.getByRole('button', { name: 'Capture the Page' });
    await expect(button).toBeVisible();
  });

  test('the button is disabled on a non-http page and enabled on a real page', async () => {
    const button = handle.window.getByRole('button', { name: 'Capture the Page' });
    // The initial tab is about:blank, which cannot be captured.
    await expect(button).toBeDisabled();

    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);
      await expect(button).toBeEnabled();
    });
  });

  test('clicking it opens the scope dialog with all three scope choices', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      await handle.window.getByRole('button', { name: 'Capture the Page' }).click();

      const dialog = handle.window.getByRole('dialog', { name: 'Capture the Page' });
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Current page only')).toBeVisible();
      await expect(dialog.getByText('Entire current website')).toBeVisible();
      await expect(dialog.getByText('Custom scope')).toBeVisible();

      // The honest limitations note must be shown before capturing.
      await expect(dialog.getByText(/can't be reproduced perfectly offline/i)).toBeVisible();
    });
  });

  test('choosing Custom scope reveals the detailed scope controls', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      await handle.window.getByRole('button', { name: 'Capture the Page' }).click();
      const dialog = handle.window.getByRole('dialog', { name: 'Capture the Page' });
      await dialog.getByText('Custom scope').click();

      await expect(dialog.getByText('Maximum link depth')).toBeVisible();
      await expect(dialog.getByText('Maximum pages')).toBeVisible();
      await expect(dialog.getByText('Maximum archive size (MB)')).toBeVisible();
      await expect(dialog.getByText('Additional allowed domains')).toBeVisible();
      await expect(dialog.getByText(/Include downloadable documents/)).toBeVisible();
      await expect(dialog.getByText(/Include audio and video/)).toBeVisible();
      await expect(dialog.getByText('Crawl delay (ms)')).toBeVisible();
      await expect(dialog.getByText('Concurrency')).toBeVisible();
    });
  });

  test('a scope beyond the recommended limits requires explicit confirmation', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      await handle.window.getByRole('button', { name: 'Capture the Page' }).click();
      const dialog = handle.window.getByRole('dialog', { name: 'Capture the Page' });
      await dialog.getByText('Custom scope').click();

      // Push the page count past the soft limit.
      const pagesInput = dialog.locator('.field-row', { hasText: 'Maximum pages' }).locator('input');
      await pagesInput.fill('500');

      const start = dialog.getByRole('button', { name: 'Start Capture' });
      await expect(start).toBeDisabled();

      // Acknowledging the warning re-enables it.
      await dialog.locator('.over-limit-warning input[type="checkbox"]').check();
      await expect(start).toBeEnabled();
    });
  });

  test('the dialog can be cancelled without starting a capture', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      await handle.window.getByRole('button', { name: 'Capture the Page' }).click();
      const dialog = handle.window.getByRole('dialog', { name: 'Capture the Page' });
      await dialog.getByRole('button', { name: 'Cancel' }).click();
      await expect(dialog).toBeHidden();

      const progress = await siteHooks(handle.app).lastCaptureProgress();
      expect(progress).toBeNull();
    });
  });

  test('the progress dialog shows live stats and a completion summary with actions', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      // Drive the capture through the hook (the save dialog is native and
      // can't be scripted), then assert the real progress UI reacts to it.
      const tabs = await siteHooks(handle.app).listTabs();
      const out = path.join(outDir, 'Ui.sitearchive');
      await siteHooks(handle.app).captureSiteToPath(tabs[0]!.id, currentPageScope(), out);

      const progressDialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await expect(progressDialog).toBeVisible();
      await expect(progressDialog.getByText('Pages discovered')).toBeVisible();
      await expect(progressDialog.getByText('Pages saved')).toBeVisible();
      await expect(progressDialog.getByText('Downloaded')).toBeVisible();
      await expect(progressDialog.getByText('Warnings')).toBeVisible();
      await expect(progressDialog.getByText('Failures')).toBeVisible();

      await siteHooks(handle.app).awaitCapture();

      await expect(progressDialog.getByText('Capture complete')).toBeVisible({ timeout: 15_000 });
      await expect(progressDialog.getByRole('button', { name: 'Open Archive' })).toBeVisible();
      await expect(progressDialog.getByRole('button', { name: /Reveal in Finder|Show in File Explorer/ })).toBeVisible();
      await expect(progressDialog.getByRole('button', { name: 'Close' })).toBeVisible();
      // The saved path is shown so the user knows where the file went.
      await expect(progressDialog.getByText(out, { exact: false })).toBeVisible();

      // Closing dismisses it.
      await progressDialog.getByRole('button', { name: 'Close' }).click();
      await expect(progressDialog).toBeHidden();
    });
  });

  test('Open Archive from the completion summary opens the archive in a tab', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const tabs = await siteHooks(handle.app).listTabs();
      const out = path.join(outDir, 'OpenMe.sitearchive');
      await siteHooks(handle.app).captureSiteToPath(tabs[0]!.id, currentPageScope(), out);
      await siteHooks(handle.app).awaitCapture();

      const progressDialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await expect(progressDialog.getByRole('button', { name: 'Open Archive' })).toBeVisible({ timeout: 15_000 });
      await progressDialog.getByRole('button', { name: 'Open Archive' }).click();

      const after = await waitForTabs(
        handle.app,
        (t) => t.some((x) => x.isSiteArchive && x.url.startsWith('archive-site://')),
        15_000,
      );
      expect(after.some((t) => t.isSiteArchive)).toBe(true);
    });
  });

  test('an archive tab shows a persistent Offline Archive indicator', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const tabs = await siteHooks(handle.app).listTabs();
      const out = path.join(outDir, 'Indicator.sitearchive');
      await siteHooks(handle.app).captureSiteToPath(tabs[0]!.id, currentPageScope(), out);
      await siteHooks(handle.app).awaitCapture();
      const progressDialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await progressDialog.getByRole('button', { name: 'Close', exact: true }).click();
      await expect(progressDialog).toBeHidden();

      await siteHooks(handle.app).openSiteArchivePath(out);
      await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive), 15_000);

      await expect(handle.window.getByText('Offline Archive')).toBeVisible();
      // The address bar is not editable while viewing an archive.
      await expect(handle.window.locator('.address-bar-input')).toBeDisabled();
    });
  });
});
