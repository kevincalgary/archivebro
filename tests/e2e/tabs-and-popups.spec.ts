import { test, expect } from '@playwright/test';
import { launchApp, navigateViaAddressBar, withFixtureServer, testHooks, waitForTabs, type AppHandle } from './helpers';

/** Click "new tab" and wait for the address bar to reflect the new (blank) tab before typing into it. */
async function openNewTab(handle: AppHandle) {
  await handle.window.locator('.tab-new').click();
  await expect(handle.window.locator('.address-bar-input')).toHaveValue('about:blank');
}

test.describe('tabs, back/forward, and popups', () => {
  let handle: AppHandle;

  test.beforeEach(async () => {
    handle = await launchApp();
  });

  test.afterEach(async () => {
    await handle.close();
  });

  test('multiple tabs can be opened and each keeps independent state', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForTabs(handle.app, (tabs) => tabs.some((t) => t.url === `${base}/`));
      await openNewTab(handle);
      await navigateViaAddressBar(handle, `${base}/page-two`);

      const tabs = await waitForTabs(
        handle.app,
        (tabs) => tabs.length === 2 && tabs.some((t) => t.url === `${base}/`) && tabs.some((t) => t.url === `${base}/page-two`),
      );
      const urls = tabs.map((t) => t.url).sort();
      expect(urls).toEqual([`${base}/`, `${base}/page-two`].sort());
    });
  });

  test('back and forward navigate within a tab', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForTabs(handle.app, (tabs) => tabs[0]?.url === `${base}/`);
      await navigateViaAddressBar(handle, `${base}/page-two`);
      await waitForTabs(handle.app, (tabs) => tabs[0]?.url === `${base}/page-two`);

      let tabs = await testHooks(handle.app).listTabs();
      expect(tabs[0]?.url).toBe(`${base}/page-two`);
      expect(tabs[0]?.canGoBack).toBe(true);

      await handle.window.getByRole('button', { name: 'Back' }).click();
      tabs = await waitForTabs(handle.app, (tabs) => tabs[0]?.url === `${base}/`);
      expect(tabs[0]?.url).toBe(`${base}/`);

      await handle.window.getByRole('button', { name: 'Forward' }).click();
      tabs = await waitForTabs(handle.app, (tabs) => tabs[0]?.url === `${base}/page-two`);
      expect(tabs[0]?.url).toBe(`${base}/page-two`);
    });
  });

  test('closing a tab removes it from the tab list', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForTabs(handle.app, (tabs) => tabs.some((t) => t.url === `${base}/`));
      await openNewTab(handle);
      await navigateViaAddressBar(handle, `${base}/page-two`);
      await waitForTabs(handle.app, (tabs) => tabs.length === 2 && tabs.some((t) => t.url === `${base}/page-two`));

      const closeButtons = handle.window.locator('.tab-close');
      await closeButtons.first().click();
      await waitForTabs(handle.app, (tabs) => tabs.length === 1);
    });
  });

  test('an unsafe scheme typed into the address bar is treated as a search, not navigated to', async () => {
    const before = await testHooks(handle.app).listTabs();
    await navigateViaAddressBar(handle, 'javascript:alert(1)');
    const after = await waitForTabs(handle.app, (tabs) => !!tabs[0]?.url && tabs[0].url !== 'about:blank');
    expect(after.length).toBe(before.length);
    // Resolved via the search engine template, never as a javascript: navigation.
    expect(after[0]?.url).not.toContain('javascript:');
  });

  test('a garbage address-bar string resolves to a search URL instead of crashing', async () => {
    await navigateViaAddressBar(handle, 'not a url just words');
    const tabs = await waitForTabs(handle.app, (tabs) => !!tabs[0]?.url.includes('duckduckgo.com'));
    expect(tabs[0]?.url).toContain('duckduckgo.com');
  });

  test('window.open() from page content opens a new managed tab rather than a raw popup window', async () => {
    await withFixtureServer(async (base) => {
      await navigateViaAddressBar(handle, `${base}/`);
      await waitForTabs(handle.app, (tabs) => tabs.some((t) => t.url === `${base}/`));
      const hooks = testHooks(handle.app);
      await hooks.evalInActiveTab(`window.open(${JSON.stringify(`${base}/page-two`)})`);

      const tabs = await waitForTabs(
        handle.app,
        (tabs) => tabs.length === 2 && tabs.some((t) => t.url === `${base}/page-two`),
      );
      expect(tabs.some((t) => t.url === `${base}/page-two`)).toBe(true);
      // The opener's own URL is untouched by window.open.
      expect(tabs.some((t) => t.url === `${base}/`)).toBe(true);
    });
  });
});
