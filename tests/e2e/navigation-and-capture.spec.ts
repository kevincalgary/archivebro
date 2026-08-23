import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, withFixtureServer, waitForArchiveCount, testHooks, type AppHandle } from './helpers';

/** Read a PNG's dimensions straight out of its IHDR header. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

test.describe('navigation and automatic capture', () => {
  let handle: AppHandle;

  test.beforeEach(async () => {
    handle = await launchApp();
    await testHooks(handle.app).updateSettings({ captureDelayMs: 300 });
  });

  test.afterEach(async () => {
    await handle.close();
  });

  test('a normal top-level navigation is captured after the settle delay', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      const items = await waitForArchiveCount(handle.app, (items) => items.some((i) => i.status === 'success'));
      const captured = items.find((i) => i.finalUrl === `${base}/`);
      expect(captured).toBeTruthy();
      expect(captured?.title).toBe('Fixture Home');
      expect(captured?.originalUrl).toBe(`${base}/`);
    });
  });

  test('a redirect is followed, and the archive records both the original and final URL', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/redirect-source`);
      const items = await waitForArchiveCount(handle.app, (items) =>
        items.some((i) => i.finalUrl === `${base}/redirect-target`),
      );
      const captured = items.find((i) => i.finalUrl === `${base}/redirect-target`);
      expect(captured?.status).toBe('success');
      expect(captured?.originalUrl).toBe(`${base}/redirect-source`);
      expect(captured?.finalUrl).toBe(`${base}/redirect-target`);
    });
  });

  test('client-rendered content that appears after load is present in the extracted text', async () => {
    await withFixtureServer(async (base) => {
      // Fixture page updates its DOM 500ms after load; capture delay here
      // (300ms) is deliberately shorter so we also prove the *settle*
      // delay, not just "any" delay, is what's configurable -- bump it up
      // for this one case so the assertion is meaningful.
      await testHooks(handle.app).updateSettings({ captureDelayMs: 1200 });
      await navigateViaAddressBar(handle, `${base}/dynamic-content`);
      const items = await waitForArchiveCount(handle.app, (items) =>
        items.some((i) => i.finalUrl === `${base}/dynamic-content` && i.status === 'success'),
      );
      const captured = items.find((i) => i.finalUrl === `${base}/dynamic-content`);
      expect(captured).toBeTruthy();
      const text = await testHooks(handle.app).readArchiveText(captured!.id);
      expect(text).toContain('Loaded');
    });
  });

  test('a page with a broken image resource still captures successfully', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/broken-resource`);
      const items = await waitForArchiveCount(handle.app, (items) =>
        items.some((i) => i.finalUrl === `${base}/broken-resource`),
      );
      expect(items.find((i) => i.finalUrl === `${base}/broken-resource`)?.status).toBe('success');
    });
  });

  test('lazy-loaded images page captures without error', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/lazy-images`);
      const items = await waitForArchiveCount(handle.app, (items) =>
        items.some((i) => i.finalUrl === `${base}/lazy-images`),
      );
      expect(items.find((i) => i.finalUrl === `${base}/lazy-images`)?.status).toBe('success');
    });
  });

  test('a very large page is captured full-page and within the raster budget', async () => {
    // End-to-end cover for the capture budget: a page far bigger than the
    // window must still produce a real full-page screenshot, and the
    // rasterized bitmap must stay inside the documented limits.
    //
    // The arithmetic itself is pinned by tests/unit/screenshotBudget.spec.ts,
    // which is what actually discriminates the corrected device-pixel
    // budget from the old CSS-pixel one. Chromium applies clamping of its
    // own on top, so this test confirms the end result is sane rather than
    // isolating the formula.
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/tall-page`);
      const items = await waitForArchiveCount(handle.app, (i) =>
        i.some((a) => a.finalUrl === `${base}/tall-page` && a.status === 'success'),
      );
      const archive = items.find((i) => i.finalUrl === `${base}/tall-page`);
      expect(archive).toBeTruthy();

      const root = await testHooks(handle.app).archivesRoot();
      const png = await fs.readFile(path.join(root, archive!.id, 'screenshot.png'));
      const { width, height } = pngSize(png);

      // The page is ~12,000 CSS px tall. A viewport crop would be roughly
      // the window height; a genuine full-page shot is many times that.
      expect(height).toBeGreaterThan(8_000);
      // Neither dimension may reach Chromium's texture ceiling...
      expect(height).toBeLessThanOrEqual(16_384);
      expect(width).toBeLessThanOrEqual(16_384);
      // ...and the whole bitmap has to stay inside the memory budget,
      // which Chromium does not enforce on its own.
      expect(width * height).toBeLessThanOrEqual(33_000_000);

      // No silent downgrade should have been recorded either.
      expect(archive!.warnings?.some((w) => w.code === 'screenshot-viewport-only')).toBeFalsy();
    });
  });

  test('SPA route changes are captured as a new version, debounced across rapid pushState calls', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/spa`);
      await waitForArchiveCount(handle.app, (items) => items.some((i) => i.finalUrl === `${base}/spa`));

      const hooks = testHooks(handle.app);
      // Three rapid route changes in quick succession should debounce into
      // ONE new captured version once things settle, not three.
      await hooks.evalInActiveTab("window.goTo('/route-a')");
      await hooks.evalInActiveTab("window.goTo('/route-b')");
      await hooks.evalInActiveTab("window.goTo('/route-c')");

      await new Promise((r) => setTimeout(r, 1000));
      const { items } = await hooks.queryArchives({ sort: 'newest', limit: 100, offset: 0 });
      const spaVersions = items.filter((i) => i.canonicalUrl === `${base}/route-c`);
      expect(spaVersions.length).toBe(1);
      expect(spaVersions[0]?.status).toBe('success');
    });
  });
});
