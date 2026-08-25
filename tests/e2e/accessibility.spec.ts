import { test, expect, type Page } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import { launchApp, navigateViaAddressBar, waitForArchiveCount, withFixtureServer, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope, dismissCaptureDialog } from './sitearchive-helpers';

/**
 * Accessibility pass (roadmap): automated regression coverage for the
 * trusted UI (the React chrome this app owns -- Toolbar, Library,
 * Settings, and every modal dialog). Browsed/archived page content is a
 * separate native WebContentsView Playwright can't attach to at all, so
 * every scan here is naturally scoped to just our own markup.
 *
 * Every dialog shares one focus-trap/Escape/restore-focus implementation
 * (useDialogA11y), so this covers each *distinct* dialog once rather than
 * exhaustively -- RecoveryDialog uses the identical hook already
 * exercised via the others and isn't separately scanned here.
 */

async function assertNoSeriousViolations(page: Page, context: string) {
  // Electron's BrowserWindow doesn't support the CDP Target.createTarget
  // call the library's default (non-legacy) analysis needs to open a
  // scratch page for cross-frame aggregation -- legacy mode runs axe
  // directly in this page's own top frame instead, which is all that's
  // needed here since the trusted UI has no iframes of its own (browsed
  // page content is a separate native WebContentsView Playwright can't
  // reach in the first place).
  const results = await new AxeBuilder({ page }).setLegacyMode(true).analyze();
  const serious = results.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  if (serious.length > 0) {
    console.log(`[a11y:${context}]`, JSON.stringify(serious, null, 2));
  }
  expect(serious.map((v) => v.id), context).toEqual([]);
}

let handle: AppHandle;

test.beforeEach(async () => {
  handle = await launchApp();
});

test.afterEach(async () => {
  await handle.close();
});

test.describe('accessibility: trusted UI', () => {
  test('the browser screen (toolbar, tab bar, address bar)', async () => {
    await assertNoSeriousViolations(handle.window, 'browser screen');
  });

  test('the Library screen, including an open archive detail panel', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.status === 'success'));

      await handle.window.getByTitle('Library (Cmd/Ctrl+Shift+L)').click();
      await expect(handle.window.locator('.archive-card').first()).toBeVisible();
      await assertNoSeriousViolations(handle.window, 'library screen');

      await handle.window.locator('.archive-card').first().click();
      await expect(handle.window.getByRole('dialog', { name: /Archive details/ })).toBeVisible();
      await assertNoSeriousViolations(handle.window, 'archive detail dialog');
    });
  });

  test('the Settings screen', async () => {
    await handle.window.getByTitle('Settings (Cmd/Ctrl+,)').click();
    await expect(handle.window.locator('.settings-screen')).toBeVisible();
    await assertNoSeriousViolations(handle.window, 'settings screen');
  });

  test('a permission prompt', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      const hooks = siteHooks(handle.app);
      void hooks.evalInActiveTab('navigator.geolocation.getCurrentPosition(function(){}, function(){}); "asked"');

      const dialog = handle.window.getByRole('dialog', { name: 'Permission request' });
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await assertNoSeriousViolations(handle.window, 'permission prompt');
    });
  });

  test('the capture-scope dialog and the capture-progress dialog', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      const hooks = siteHooks(handle.app);

      // Scanned via a real click, same as a user would open it.
      await handle.window.locator('.capture-page-button').click();
      const scopeDialog = handle.window.getByRole('dialog', { name: 'Capture the Page' });
      await expect(scopeDialog).toBeVisible();
      await assertNoSeriousViolations(handle.window, 'capture scope dialog');
      // Cancelled rather than clicking "Start Capture": that button drives
      // a real native dialog.showSaveDialog(), which no automated test can
      // answer -- every other capture test in this suite starts the job
      // via captureSiteToPath() (below) for exactly this reason.
      await scopeDialog.getByRole('button', { name: 'Cancel' }).click();

      const tabs = await hooks.listTabs();
      const tabId = tabs[0]?.id;
      if (!tabId) throw new Error('No tab');
      const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'a11y-capture-'));
      try {
        await hooks.captureSiteToPath(tabId, currentPageScope(), path.join(outDir, 'A11y.sitearchive'));
        const progressDialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
        await expect(progressDialog).toBeVisible();
        await assertNoSeriousViolations(handle.window, 'capture progress dialog');

        await hooks.awaitCapture();
        await assertNoSeriousViolations(handle.window, 'capture progress dialog (completed)');
        await dismissCaptureDialog(handle);
      } finally {
        await fs.rm(outDir, { recursive: true, force: true });
      }
    });
  });
});
