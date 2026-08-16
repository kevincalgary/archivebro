import { test, expect } from '@playwright/test';
import { launchApp, navigateViaAddressBar, withFixtureServer, waitForArchiveCount, testHooks, type AppHandle } from './helpers';

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
