import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope, siteScope, dismissCaptureDialog } from './sitearchive-helpers';

/**
 * The user-facing recovery flow (roadmap priority #1): a dialog offering
 * Finish / Resume / Discard for any capture left interrupted by a crash or
 * a failure that couldn't reach the final write. The checkpoint/resume
 * machinery itself (replay, salvage, continue) is exercised at the main-
 * process level in sitearchive-recovery.spec.ts; this file drives the same
 * scenarios through the real dialog a user actually sees, one app relaunch
 * at a time -- the dialog is only (re)computed at startup.
 */

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-ui-'));
});

test.afterEach(async () => {
  // Staging trees live in the shared OS temp directory, not this test's
  // own outDir, so a test that leaves one behind pollutes every later
  // test's view of what's recoverable -- discard only the ones this test
  // created (identified by their outputPath living under outDir).
  try {
    for (const r of await siteHooks(handle.app).listRecoverableCaptures()) {
      if (r.outputPath.startsWith(outDir)) await siteHooks(handle.app).discardRecoveredCapture(r.stagingDir);
    }
  } catch {
    // App may already be gone; the sweep will reclaim these regardless.
  }
  await handle.close();
  await fs.rm(outDir, { recursive: true, force: true });
});

/** The recovery dialog, scoped to the row this test created (by its unique startUrl). */
function recoveryRowFor(h: AppHandle, siteUrl: string) {
  return h.window.getByRole('dialog', { name: 'Interrupted captures' }).locator('.recovery-item', { hasText: siteUrl });
}

/**
 * Crawl the fixture site for real, but aim the output at a path that
 * cannot be written: the parent is a regular file, so the final
 * mkdir/rename fails after every page has already been captured -- the
 * exact shape of a real capture that dies at the last step.
 */
async function crawlAndFailAtTheEnd(
  h: AppHandle,
  dir: string,
  scope = currentPageScope(),
): Promise<{ blocker: string; outputPath: string }> {
  const blocker = path.join(dir, 'blocker');
  await fs.writeFile(blocker, 'not a directory');
  const outputPath = path.join(blocker, 'site.sitearchive');

  const hooks = siteHooks(h.app);
  const tabs = await hooks.listTabs();
  await hooks.captureSiteToPath(tabs[0]!.id, scope, outputPath);
  const result = await hooks.awaitCapture();
  expect(result).toBeNull();
  await expect(fs.stat(outputPath)).rejects.toThrow();

  return { blocker, outputPath };
}

test.describe('recovering an interrupted capture from the UI', () => {
  test('no recovery prompt appears when there is nothing to recover', async () => {
    const dialog = handle.window.getByRole('dialog', { name: 'Interrupted captures' });
    await expect(dialog).toBeHidden();
  });

  test('lists what was captured so far, and Finish saves it as a normal archive', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);
      const { blocker, outputPath } = await crawlAndFailAtTheEnd(handle, outDir);
      // Clear whatever made the original write fail, so Finish can succeed.
      await fs.rm(blocker, { force: true });

      // The dialog is only computed at startup -- relaunch to see it.
      await handle.close();
      handle = await launchApp();

      const row = recoveryRowFor(handle, `${site.url}/`);
      await expect(row).toBeVisible();
      await expect(row.getByText('1 page captured', { exact: false })).toBeVisible();
      await expect(row.getByText(outputPath, { exact: false })).toBeVisible();

      await row.getByRole('button', { name: 'Finish' }).click();

      const progressDialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await expect(progressDialog.getByText('Capture complete')).toBeVisible({ timeout: 15_000 });
      await expect(progressDialog.getByText(outputPath, { exact: false })).toBeVisible();

      // Finishing hands off to the progress dialog; the recovery prompt
      // must not still be sitting underneath it.
      await expect(handle.window.getByRole('dialog', { name: 'Interrupted captures' })).toBeHidden();

      await progressDialog.getByRole('button', { name: 'Open Archive' }).click();
      const after = await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive), 15_000);
      expect(after.some((t) => t.isSiteArchive)).toBe(true);
    });
  });

  test('Resume continues the crawl from the checkpoint instead of restarting it', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);
      const { blocker } = await crawlAndFailAtTheEnd(handle, outDir, siteScope({ maxPages: 4, maxDepth: 2 }));

      const pagesFetchedBefore = site
        .getRequestLog()
        .filter((r) => !r.url.includes('.'))
        .map((r) => r.url);
      expect(pagesFetchedBefore.length).toBeGreaterThan(0);
      const requestsBefore = site.getRequestLog().length;

      await fs.rm(blocker, { force: true });
      await handle.close();
      handle = await launchApp();

      const row = recoveryRowFor(handle, `${site.url}/`);
      await expect(row).toBeVisible();
      await row.getByRole('button', { name: 'Resume' }).click();

      // Resuming is a real capture job, reported through the same progress
      // dialog a fresh capture uses.
      await expect(handle.window.getByRole('dialog', { name: 'Interrupted captures' })).toBeHidden();
      const progressDialog = handle.window.getByRole('dialog', { name: 'Capture progress' });
      await expect(progressDialog.getByText('Capture complete')).toBeVisible({ timeout: 20_000 });

      // The point of resuming: work already done is not redone.
      const refetched = site
        .getRequestLog()
        .slice(requestsBefore)
        .filter((r) => pagesFetchedBefore.includes(r.url));
      expect(refetched).toEqual([]);

      await dismissCaptureDialog(handle);
    });
  });

  test('Discard requires confirmation before removing anything', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);
      await crawlAndFailAtTheEnd(handle, outDir);

      await handle.close();
      handle = await launchApp();

      const row = recoveryRowFor(handle, `${site.url}/`);
      await expect(row).toBeVisible();

      const recoverableBefore = await siteHooks(handle.app).listRecoverableCaptures();
      expect(recoverableBefore.some((r) => r.outputPath.startsWith(outDir))).toBe(true);

      // First click only asks; nothing is removed yet.
      await row.getByRole('button', { name: 'Discard' }).click();
      await expect(row.getByText(/discard everything captured so far/i)).toBeVisible();
      const recoverableStillThere = await siteHooks(handle.app).listRecoverableCaptures();
      expect(recoverableStillThere.some((r) => r.outputPath.startsWith(outDir))).toBe(true);

      // Cancelling backs out without discarding.
      await row.getByRole('button', { name: 'Cancel' }).click();
      await expect(row).toBeVisible();
      const recoverableAfterCancel = await siteHooks(handle.app).listRecoverableCaptures();
      expect(recoverableAfterCancel.some((r) => r.outputPath.startsWith(outDir))).toBe(true);

      // Confirming actually discards it.
      await row.getByRole('button', { name: 'Discard' }).click();
      await row.getByRole('button', { name: 'Discard' }).click();
      await expect(handle.window.getByRole('dialog', { name: 'Interrupted captures' })).toBeHidden();

      const recoverableAfterDiscard = await siteHooks(handle.app).listRecoverableCaptures();
      expect(recoverableAfterDiscard.some((r) => r.outputPath.startsWith(outDir))).toBe(false);
    });
  });

  test('an unresolved prompt reappears on the next launch; resolving it stops the prompts', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);
      await crawlAndFailAtTheEnd(handle, outDir);

      // First relaunch: dismissing without acting must not resolve anything.
      await handle.close();
      handle = await launchApp();
      let row = recoveryRowFor(handle, `${site.url}/`);
      await expect(row).toBeVisible();
      await handle.window.getByRole('dialog', { name: 'Interrupted captures' }).getByRole('button', { name: 'Not now' }).click();
      await expect(handle.window.getByRole('dialog', { name: 'Interrupted captures' })).toBeHidden();

      // Second relaunch: still unresolved, so it's offered again.
      await handle.close();
      handle = await launchApp();
      row = recoveryRowFor(handle, `${site.url}/`);
      await expect(row).toBeVisible();

      // Resolve it this time.
      await row.getByRole('button', { name: 'Discard' }).click();
      await row.getByRole('button', { name: 'Discard' }).click();
      await expect(handle.window.getByRole('dialog', { name: 'Interrupted captures' })).toBeHidden();

      // Third relaunch: nothing left to recover.
      await handle.close();
      handle = await launchApp();
      await expect(handle.window.getByRole('dialog', { name: 'Interrupted captures' })).toBeHidden();
    });
  });
});
