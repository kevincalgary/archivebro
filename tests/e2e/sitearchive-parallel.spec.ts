import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, siteScope } from './sitearchive-helpers';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';

/**
 * Parallel crawling (roadmap): scope.concurrency now actually controls how
 * many pages are captured at once, each against its own hidden view, rather
 * than being validated and plumbed through with no effect on a strictly
 * sequential crawl.
 */

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-parallel-'));
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

test.describe('parallel site capture', () => {
  test('concurrency > 1 captures the same page budget in meaningfully less wall-clock time', async () => {
    await withSiteFixture(async (fixture) => {
      await navigateViaAddressBar(handle, fixture.url);
      const hooks = siteHooks(handle.app);
      const tabId = await activeTabId();

      // crawlDelayMs is deliberately non-zero here (siteScope() otherwise
      // defaults it to 0 for fast tests) -- it's what's documented as
      // "milliseconds between requests issued by a single worker", so with
      // real concurrency the wall-clock cost of N workers each paying it
      // should come down close to linearly with worker count, not stay flat.
      const scopeFor = (concurrency: number) =>
        siteScope({ maxPages: 8, maxDepth: 4, crawlDelayMs: 250, concurrency });

      const sequentialOut = path.join(outDir, 'sequential.sitearchive');
      const sequentialStart = Date.now();
      await hooks.captureSiteToPath(tabId, scopeFor(1), sequentialOut);
      const sequentialResult = await hooks.awaitCapture();
      const sequentialMs = Date.now() - sequentialStart;
      expect(sequentialResult).not.toBeNull();

      const parallelOut = path.join(outDir, 'parallel.sitearchive');
      const parallelStart = Date.now();
      await hooks.captureSiteToPath(tabId, scopeFor(4), parallelOut);
      const parallelResult = await hooks.awaitCapture();
      const parallelMs = Date.now() - parallelStart;
      expect(parallelResult).not.toBeNull();

      // Both captures cover the identical page budget on the identical
      // fixture, so this isn't comparing different amounts of work.
      expect(parallelResult!.pageCount).toBe(sequentialResult!.pageCount);

      // A generous threshold (not e.g. 1/4) so ordinary CI timing noise
      // can't make this flaky -- the point is "meaningfully parallel", not
      // "exactly N times faster".
      expect(parallelMs).toBeLessThan(sequentialMs * 0.7);
    });
  });

  test('concurrent workers fetching identical bytes under different URLs dedupe to one entry with every source URL kept', async () => {
    await withSiteFixture(async (fixture) => {
      await navigateViaAddressBar(handle, fixture.url);
      const hooks = siteHooks(handle.app);
      const tabId = await activeTabId();
      const outputPath = path.join(outDir, 'concurrent-dedup.sitearchive');

      // /img/bg.png (a CSS background-image on the home page) and
      // /img/blue.png (an <img> on /products/widget) are served identical
      // bytes under different URLs (see fixtures/siteServer.js) -- unlike
      // /img/logo.svg, which every page references via the exact same
      // absolute URL string and so was never going to produce more than
      // one sourceUrl regardless of concurrency. With 6-way concurrency
      // over enough pages, the two pages referencing this asset are
      // fetched by different workers at essentially the same time, which
      // is exactly the race SiteArchiveBuilder.addAsset's in-flight-write
      // guard exists for (see its unit tests for the deterministic version
      // of this same scenario).
      await hooks.captureSiteToPath(tabId, siteScope({ maxPages: 12, maxDepth: 4, crawlDelayMs: 0, concurrency: 6 }), outputPath);
      const result = await hooks.awaitCapture();
      expect(result).not.toBeNull();
      expect(result!.pageCount).toBeGreaterThan(5);

      const archive = await openSiteArchive(outputPath);
      const sharedAssets = archive.manifest.assets.filter((a) =>
        a.sourceUrls.some((u) => u.endsWith('/img/bg.png') || u.endsWith('/img/blue.png')),
      );
      archive.close();

      // One stored entry, not one per racing writer.
      expect(sharedAssets).toHaveLength(1);
      // Both distinct URLs made it into sourceUrls -- the failure mode the
      // race produced was a second writer's sourceUrl silently vanishing.
      expect(sharedAssets[0]!.sourceUrls.some((u) => u.endsWith('/img/bg.png'))).toBe(true);
      expect(sharedAssets[0]!.sourceUrls.some((u) => u.endsWith('/img/blue.png'))).toBe(true);
    });
  });
});
