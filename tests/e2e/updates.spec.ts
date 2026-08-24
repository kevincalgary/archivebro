import { test, expect } from '@playwright/test';
import { launchApp, testHooks, type AppHandle } from './helpers';

test.describe('auto-update', () => {
  let handle: AppHandle;

  test.beforeEach(async () => {
    handle = await launchApp();
  });

  test.afterEach(async () => {
    await handle.close();
  });

  test('never checks for updates in this (unpackaged) build, on startup or on demand', async () => {
    // Startup alone -- with no explicit check -- must already reflect that
    // this environment can't do this, confirming UpdateService.start()
    // never even attempts the network request rather than merely skipping
    // an automatic timer.
    const startupStatus = await handle.window.evaluate(() => (window as any).archiveBrowser.updates.getStatus());
    expect(startupStatus.state).toBe('unsupported-dev');

    // A manual, explicit "check now" -- the one path that's supposed to
    // always be allowed regardless of the auto-check setting -- still must
    // not attempt a real network call while unpackaged.
    const manualStatus = await handle.window.evaluate(() => (window as any).archiveBrowser.updates.checkNow());
    expect(manualStatus.state).toBe('unsupported-dev');
  });

  test('the automatic-check setting persists independently of the manual check', async () => {
    const hooks = testHooks(handle.app);
    expect((await hooks.getSettings()).autoUpdateCheckEnabled).toBe(true);

    await hooks.updateSettings({ autoUpdateCheckEnabled: false });
    expect((await hooks.getSettings()).autoUpdateCheckEnabled).toBe(false);

    // Turning automatic checks off must not disable the manual button --
    // it's still just answered with "unsupported-dev" here, not refused.
    const status = await handle.window.evaluate(() => (window as any).archiveBrowser.updates.checkNow());
    expect(status.state).toBe('unsupported-dev');
  });
});
