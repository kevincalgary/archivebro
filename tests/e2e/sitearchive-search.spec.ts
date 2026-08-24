import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, siteScope, dismissCaptureDialog } from './sitearchive-helpers';

/**
 * Search inside a .sitearchive (roadmap): the FTS5 index shipped in
 * index.sqlite (see archiveWriter.ts's writeIndexDatabase) is what
 * OpenedArchive.search() queries, surfaced in the trusted UI's toolbar
 * while viewing an archive tab.
 */

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-search-'));
});

test.afterEach(async () => {
  await handle.close();
  await fs.rm(outDir, { recursive: true, force: true });
});

test.describe('searching inside an open site archive', () => {
  test('finds the page whose extracted text matches, and navigating to a result opens that page', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'Searchable.sitearchive');
      // Enough pages/depth to reach /about, which -- unlike the fixture's
      // shared nav links and layout -- has body text ("Fragment target.")
      // that appears nowhere else on the site, so a match proves search
      // found the right page rather than any page.
      await hooks.captureSiteToPath(tabs[0]!.id, siteScope({ maxPages: 6, maxDepth: 2 }), out);
      const result = await hooks.awaitCapture();
      expect(result).not.toBeNull();
      await dismissCaptureDialog(handle);

      await hooks.openSiteArchivePath(out);
      await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive), 15_000);

      await handle.window.getByRole('button', { name: 'Search inside this archive' }).click();
      await handle.window.getByPlaceholder('Search this archive…').fill('Fragment target');

      const result_ = handle.window.locator('.sitearchive-search-result');
      await expect(result_).toHaveCount(1, { timeout: 5000 });
      await expect(result_.locator('.sitearchive-search-result-title')).toHaveText('About the Fixture');

      await result_.click();

      await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive && x.title === 'About the Fixture'), 10_000);
    });
  });

  test('a term found on no page returns no results', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'NoMatch.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, siteScope({ maxPages: 6, maxDepth: 2 }), out);
      await hooks.awaitCapture();
      await dismissCaptureDialog(handle);

      await hooks.openSiteArchivePath(out);
      await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive), 15_000);

      await handle.window.getByRole('button', { name: 'Search inside this archive' }).click();
      await handle.window.getByPlaceholder('Search this archive…').fill('zzzznonexistentqueryzzzz');

      await expect(handle.window.locator('.sitearchive-search-empty')).toBeVisible({ timeout: 5000 });
      await expect(handle.window.locator('.sitearchive-search-result')).toHaveCount(0);
    });
  });

  test('switching tabs closes the search panel rather than leaving it open against the wrong tab', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const hooks = siteHooks(handle.app);
      const tabs = await hooks.listTabs();
      const out = path.join(outDir, 'SwitchAway.sitearchive');
      await hooks.captureSiteToPath(tabs[0]!.id, siteScope({ maxPages: 6, maxDepth: 2 }), out);
      await hooks.awaitCapture();
      await dismissCaptureDialog(handle);

      await hooks.openSiteArchivePath(out);
      await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive), 15_000);

      await handle.window.getByRole('button', { name: 'Search inside this archive' }).click();
      await expect(handle.window.locator('.sitearchive-search-panel')).toBeVisible();

      // Back to the live browsing tab, which has no search button at all.
      await handle.window.locator('.tab').first().click();
      await expect(handle.window.locator('.sitearchive-search-panel')).toBeHidden();
      await expect(handle.window.getByRole('button', { name: 'Search inside this archive' })).toHaveCount(0);
    });
  });
});
