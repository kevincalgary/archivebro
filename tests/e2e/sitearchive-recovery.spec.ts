import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, siteScope } from './sitearchive-helpers';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';

/**
 * Recovering an interrupted `.sitearchive` capture.
 *
 * The archive is only zipped and renamed into place once the whole crawl
 * finishes. That is what makes a half-written archive impossible, but it
 * also meant a 151-minute, 810-page crawl that died at the end produced
 * nothing whatsoever. Every captured byte was still staged on disk; only
 * the in-memory bookkeeping was lost.
 *
 * These drive a *real* crawl of the fixture site and make it fail at the
 * final step, which is the exact shape of that incident.
 */

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'recovery-'));
});

test.afterEach(async () => {
  // Staging trees live in the shared OS temp directory and survive a
  // failed capture by design, so a test that leaves one behind leaks
  // hundreds of KB and pollutes the next test's view of what's
  // recoverable. Discard only the ones this test created.
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

/** Only the captures this test created, ignoring any sibling's leftovers. */
async function ownRecoverable() {
  return (await siteHooks(handle.app).listRecoverableCaptures()).filter((r) => r.outputPath.startsWith(outDir));
}

async function activeTabId(): Promise<string> {
  const tabs = await siteHooks(handle.app).listTabs();
  const id = tabs[0]?.id;
  if (!id) throw new Error('No tab');
  return id;
}

/**
 * Crawl the fixture site for real, but aim the output at a path that
 * cannot be written: the parent is a regular file, so the final
 * mkdir/rename fails after every page has already been captured.
 */
async function crawlAndFailAtTheEnd(): Promise<{ blocker: string; outputPath: string }> {
  const blocker = path.join(outDir, 'blocker');
  await fs.writeFile(blocker, 'not a directory');
  const outputPath = path.join(blocker, 'site.sitearchive');

  const hooks = siteHooks(handle.app);
  await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxPages: 4, maxDepth: 2 }), outputPath);
  const result = await hooks.awaitCapture();

  // The capture really did fail -- no archive was produced.
  expect(result).toBeNull();
  await expect(fs.stat(outputPath)).rejects.toThrow();

  return { blocker, outputPath };
}

test.describe('interrupted site captures', () => {
  test('a capture that fails at the final step is still recoverable', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      await crawlAndFailAtTheEnd();

      // The staged work survived the failure instead of being deleted.
      const recoverable = await ownRecoverable();
      expect(recoverable).toHaveLength(1);
      expect(recoverable[0]!.startUrl).toBe(`${site.url}/`);
      expect(recoverable[0]!.bytesOnDisk).toBeGreaterThan(0);
    });
  });

  test('the salvaged archive opens and holds the pages that were captured', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const { blocker, outputPath } = await crawlAndFailAtTheEnd();

      const hooks = siteHooks(handle.app);
      const target = (await ownRecoverable()).find((r) => r.outputPath === outputPath);
      expect(target).toBeTruthy();

      // Clear whatever made the original write fail, then salvage.
      await fs.rm(blocker, { force: true });
      const saved = await hooks.finalizeRecoveredCapture(target!.stagingDir);

      expect(saved).not.toBeNull();
      expect(saved!.pageCount).toBeGreaterThan(0);

      // The salvaged file is a genuine archive: it opens, and every entry
      // passes the same checksum verification as a normally-written one.
      const opened = await openSiteArchive(saved!.archivePath);
      try {
        expect(opened.manifest.pages.length).toBe(saved!.pageCount);
        expect(opened.entryPageId).toBeTruthy();
      } finally {
        await opened.close?.();
      }

      // Salvaging consumes the staging tree, so it can't be salvaged twice.
      expect(await ownRecoverable()).toHaveLength(0);
    });
  });

  test('resuming continues the crawl instead of starting over', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const { blocker, outputPath } = await crawlAndFailAtTheEnd();

      const hooks = siteHooks(handle.app);
      const target = (await ownRecoverable()).find((r) => r.outputPath === outputPath);
      expect(target).toBeTruthy();
      const archiveIdBefore = target!.archiveId;

      // Which pages the crawl actually fetched before it died.
      const pagesFetchedBefore = site
        .getRequestLog()
        .filter((r) => !r.url.includes('.'))
        .map((r) => r.url);
      expect(pagesFetchedBefore.length).toBeGreaterThan(0);
      const requestsBefore = site.getRequestLog().length;

      await fs.rm(blocker, { force: true });
      const resumed = await hooks.resumeInterruptedCapture(target!.stagingDir);
      expect(resumed).not.toBeNull();

      const result = await hooks.awaitCapture();
      expect(result).not.toBeNull();
      expect(result!.pageCount).toBeGreaterThan(0);

      // The point of resuming: work already done is not redone. None of
      // the pages captured before the interruption may be requested again.
      const refetched = site
        .getRequestLog()
        .slice(requestsBefore)
        .filter((r) => pagesFetchedBefore.includes(r.url));
      expect(refetched).toEqual([]);

      const opened = await openSiteArchive(result!.archivePath);
      try {
        // The resumed run must keep the original archive id: it is baked
        // into the archive-site:// URLs already serialized into pages
        // captured before the interruption, so a new id would break every
        // rewritten link in them.
        expect(opened.manifest.archiveId).toBe(archiveIdBefore);
        // No page is captured twice across the interruption.
        const ids = opened.manifest.pages.map((p) => p.normalizedUrl);
        expect(new Set(ids).size).toBe(ids.length);
      } finally {
        await opened.close?.();
      }
    });
  });
});
