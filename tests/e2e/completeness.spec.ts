import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope } from './sitearchive-helpers';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'completeness-'));
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

test.describe('permission prompts', () => {
  test('an "ask" permission shows a prompt instead of silently denying', async () => {
    await withSiteFixture(async (site) => {
      // geolocation defaults to 'ask'.
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const hooks = siteHooks(handle.app);
      // Trigger a real permission request from page content.
      void hooks.evalInActiveTab('navigator.geolocation.getCurrentPosition(function(){}, function(){}); "asked"');

      const dialog = handle.window.getByRole('dialog', { name: 'Permission request' });
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await expect(dialog.getByText('know your location')).toBeVisible();
      // Only the origin is shown, never a full URL with a path.
      await expect(dialog.getByText(site.url, { exact: false })).toBeVisible();
    });
  });

  test('the prompt is not hidden behind the page', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);
      const hooks = siteHooks(handle.app);
      expect((await hooks.contentBounds()).height).toBeGreaterThan(0);

      void hooks.evalInActiveTab('navigator.geolocation.getCurrentPosition(function(){}, function(){}); "asked"');
      await expect(handle.window.getByRole('dialog', { name: 'Permission request' })).toBeVisible({ timeout: 15_000 });

      // Same native-occlusion trap as the other dialogs.
      await expect.poll(async () => (await hooks.contentBounds()).height, { timeout: 10_000 }).toBe(0);
    });
  });

  test('Block answers the request and dismisses the prompt', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const hooks = siteHooks(handle.app);
      void hooks.evalInActiveTab('navigator.geolocation.getCurrentPosition(function(){}, function(){}); "asked"');

      const dialog = handle.window.getByRole('dialog', { name: 'Permission request' });
      await expect(dialog).toBeVisible({ timeout: 15_000 });
      await dialog.getByRole('button', { name: 'Block' }).click();
      await expect(dialog).toBeHidden();

      // The page is uncovered again once nothing is being asked.
      await expect.poll(async () => (await hooks.contentBounds()).height, { timeout: 10_000 }).toBeGreaterThan(0);
    });
  });

  test('"remember this choice" turns the answer into a standing default', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const hooks = siteHooks(handle.app);
      expect((await hooks.getSettings()).permissionDefaults.geolocation).toBe('ask');

      void hooks.evalInActiveTab('navigator.geolocation.getCurrentPosition(function(){}, function(){}); "asked"');
      const dialog = handle.window.getByRole('dialog', { name: 'Permission request' });
      await expect(dialog).toBeVisible({ timeout: 15_000 });

      await dialog.locator('input[type="checkbox"]').check();
      await dialog.getByRole('button', { name: 'Block' }).click();

      await expect.poll(async () => (await hooks.getSettings()).permissionDefaults.geolocation, {
        timeout: 10_000,
      }).toBe('deny');
    });
  });

  test('a permission set to deny never prompts at all', async () => {
    await withSiteFixture(async (site) => {
      await siteHooks(handle.app).updateSettings({
        permissionDefaults: { ...(await siteHooks(handle.app).getSettings()).permissionDefaults, geolocation: 'deny' },
      });
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      void siteHooks(handle.app).evalInActiveTab(
        'navigator.geolocation.getCurrentPosition(function(){}, function(){}); "asked"',
      );
      await handle.window.waitForTimeout(2500);
      await expect(handle.window.getByRole('dialog', { name: 'Permission request' })).toHaveCount(0);
    });
  });
});

test.describe('diagnostic logging setting', () => {
  test('is off by default and can be turned on from Settings', async () => {
    const hooks = siteHooks(handle.app);
    expect((await hooks.getSettings()).diagnosticLogging).toBe(false);

    await handle.window.getByRole('button', { name: 'Settings' }).click();
    const toggle = handle.window
      .locator('.checkbox-row', { hasText: 'Record full URLs in the log file' })
      .locator('input[type="checkbox"]');
    await expect(toggle).toBeVisible();
    await expect(toggle).not.toBeChecked();

    // The checkbox is controlled by state that only updates after the
    // settings round-trip completes, so click and then poll for the
    // effect rather than using check(), which asserts the state
    // synchronously and races the update.
    await toggle.click();
    await expect.poll(async () => (await hooks.getSettings()).diagnosticLogging, { timeout: 10_000 }).toBe(true);
    await expect(toggle).toBeChecked();

    await toggle.click();
    await expect.poll(async () => (await hooks.getSettings()).diagnosticLogging, { timeout: 10_000 }).toBe(false);
    await expect(toggle).not.toBeChecked();
  });
});

test.describe('cross-origin frames', () => {
  test('are replaced with a clearly marked placeholder, not left blank', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/frames`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/frames'));
      await handle.window.waitForTimeout(800);

      const out = path.join(outDir, 'Frames.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const page = archive.manifest.pages[0]!;
        const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');

        // The cross-origin frame is explained rather than silently blank.
        expect(html).toContain('cross-origin-frame');
        expect(html).toContain('was not archived');

        // Crucially, no <iframe> is left pointing at the live web -- the
        // original address survives only as a provenance attribute on the
        // placeholder, which cannot load anything.
        expect(html).not.toMatch(/<iframe[^>]*\ssrc="https?:\/\//i);
        expect(html).toContain('data-archive-original-src="http://127.0.0.1:1/embedded"');

        // The same-origin frame is archived normally, not placeholdered.
        expect(html).toContain('id="same"');
        expect(html).toMatch(/<iframe[^>]*id="same"[^>]*src="archive-site:\/\//i);
      } finally {
        archive.close();
      }
    });
  });
});
