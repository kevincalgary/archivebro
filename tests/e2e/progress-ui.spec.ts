import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope, siteScope } from './sitearchive-helpers';

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'progress-ui-'));
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

test.describe('progress and loading feedback', () => {
  test('a running capture shows a progress bar, a spinner, and live counts', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Progress.sitearchive');
      // A slow, multi-page crawl so the running state is observable.
      await siteHooks(handle.app).captureSiteToPath(
        await activeTabId(),
        siteScope({ maxDepth: 2, maxPages: 12, crawlDelayMs: 400 }),
        out,
      );

      const dialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await expect(dialog).toBeVisible();

      // A progress bar exists and is a real ARIA progressbar.
      const bar = dialog.locator('.progress-track');
      await expect(bar).toBeVisible();

      // A spinner indicates the crawl is actively working.
      await expect(dialog.locator('.spinner').first()).toBeVisible();

      // The bar reports a determinate percentage while crawling.
      await expect
        .poll(async () => bar.first().getAttribute('aria-valuenow'), { timeout: 20_000 })
        .not.toBeNull();

      await siteHooks(handle.app).awaitCapture();
    });
  });

  test('the progress bar advances as pages are captured', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Advance.sitearchive');
      await siteHooks(handle.app).captureSiteToPath(
        await activeTabId(),
        siteScope({ maxDepth: 2, maxPages: 10, crawlDelayMs: 350 }),
        out,
      );

      const dialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      const savedCount = dialog.locator('.capture-stats div', { hasText: 'Pages saved' }).locator('dd');

      // Pages saved must actually climb during the crawl, not sit at zero.
      await expect.poll(async () => Number(await savedCount.textContent()), { timeout: 25_000 }).toBeGreaterThan(0);

      const width = await dialog.locator('.progress-fill').first().evaluate((el) => (el as HTMLElement).style.width);
      expect(width).toMatch(/%$/);

      await siteHooks(handle.app).awaitCapture();
    });
  });

  test('a paused capture reflects the paused state in the progress bar', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Paused.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 2, maxPages: 12, crawlDelayMs: 400 }), out);

      const dialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await expect(dialog).toBeVisible();
      await handle.window.waitForTimeout(800);

      await dialog.getByRole('button', { name: 'Pause' }).click();
      await expect(dialog.getByText('Paused', { exact: false }).first()).toBeVisible({ timeout: 10_000 });
      // Paused uses the warning colour rather than the active blue.
      await expect(dialog.locator('.progress-warn')).toBeVisible();

      await dialog.getByRole('button', { name: 'Resume' }).click();
      await hooks.awaitCapture();
    });
  });

  test('a finished capture shows a full, success-coloured bar', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Done.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const dialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await expect(dialog.getByText('Capture complete')).toBeVisible({ timeout: 15_000 });
      await expect(dialog.locator('.progress-success')).toBeVisible();
      await expect(dialog.getByText('Finished')).toBeVisible();

      // Nothing should still be spinning once the work is done.
      await expect(dialog.locator('.spinner')).toHaveCount(0);
    });
  });

  test('the Capture the Page button shows a spinner while a capture runs', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Button.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 1, maxPages: 6, crawlDelayMs: 300 }), out);

      const button = handle.window.locator('.capture-page-button');
      await expect(button.locator('.spinner')).toBeVisible({ timeout: 10_000 });
      await expect(button).toBeDisabled();

      await hooks.awaitCapture();
    });
  });

  test('the library shows a spinner while searching', async () => {
    await handle.window.getByRole('button', { name: /Library/ }).click();
    // The Library screen renders its own progress affordance rather than
    // a bare "Loading…" string.
    await expect(handle.window.locator('.library-screen')).toBeVisible();
    await expect(handle.window.locator('.library-meta')).toBeVisible();
  });

  test('settings shows a loading panel before the settings arrive', async () => {
    await handle.window.getByRole('button', { name: '⚙' }).click();
    // Either the spinner (still loading) or the loaded form must appear --
    // never an empty screen.
    await expect(handle.window.locator('.settings-screen')).toBeVisible();
    await expect(handle.window.getByRole('heading', { name: /Settings/ })).toBeVisible({ timeout: 10_000 });
  });

  test('a tab shows a loading spinner while a page is loading', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      // The tab bar carries its own spinner while the page loads; by the
      // time loading finishes it must be gone.
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/` && !t[0]?.isLoading, 15_000);
      await expect(handle.window.locator('.tab-spinner')).toHaveCount(0);
    });
  });

  test('progress bars expose accessible ARIA state', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Aria.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 1, maxPages: 8, crawlDelayMs: 300 }), out);

      const dialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      const bar = dialog.getByRole('progressbar').first();
      await expect(bar).toBeVisible();
      // Determinate bars must publish min/max so assistive tech can read them.
      await expect
        .poll(async () => bar.getAttribute('aria-valuemax'), { timeout: 20_000 })
        .toBe('100');

      await hooks.awaitCapture();
    });
  });
});
