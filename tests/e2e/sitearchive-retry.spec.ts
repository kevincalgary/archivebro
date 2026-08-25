import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, siteScope, dismissCaptureDialog } from './sitearchive-helpers';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';

/**
 * Resume-only retry (roadmap): retrying a finished capture's failed pages
 * re-attempts exactly those pages, not the whole capture -- pages that
 * already succeeded are never re-fetched.
 */

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-retry-'));
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

async function captureHub(site: { url: string }, outDir: string, name: string) {
  await navigateViaAddressBar(handle, `${site.url}/retry-test-hub`);
  await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/retry-test-hub`);

  const hooks = siteHooks(handle.app);
  const out = path.join(outDir, name);
  // maxDepth: 1 -- hub discovers its direct links (including the fixture's
  // shared nav) but they don't discover further, keeping this bounded and
  // predictable regardless of how deep the rest of the fixture site goes.
  await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxPages: 10, maxDepth: 1, crawlDelayMs: 0 }), out);
  const result = await hooks.awaitCapture();
  await dismissCaptureDialog(handle);
  return { hooks, out, result };
}

test.describe('resume-only retry of failed pages', () => {
  test('retries only the failed page, without re-fetching pages that already succeeded', async () => {
    await withSiteFixture(async (site) => {
      // /retry-test-hub links to /flaky, which redirects to itself (a real
      // redirect-loop failure) until GET /flaky-fix is called -- see
      // fixtures/siteServer.js. Nothing else links to the hub, so no other
      // test's whole-site crawl is affected by /flaky being broken here.
      const { hooks, out, result: initial } = await captureHub(site, outDir, 'Retry.sitearchive');
      expect(initial).not.toBeNull();

      const flakyFailure = initial!.failures.find((f) => f.url.endsWith('/flaky'));
      expect(flakyFailure?.kind).toBe('redirect-loop');
      // Everything else the hub links to (including the fixture's shared
      // nav) succeeded -- only /flaky is broken.
      expect(initial!.failures).toHaveLength(1);

      const beforeArchive = await openSiteArchive(out);
      const alreadySucceededUrls = beforeArchive.manifest.pages.map((p) => new URL(p.finalUrl).pathname);
      beforeArchive.close();
      expect(alreadySucceededUrls).not.toContain('/flaky');

      // "The site got fixed" -- simulated explicitly rather than by
      // guessing a request count, so this test can't be timing-dependent.
      await fetch(`${site.url}/flaky-fix`);

      const requestsBeforeRetry = site.getRequestLog().length;
      await hooks.retryFailedPages(out);
      const retried = await hooks.awaitCapture();
      expect(retried).not.toBeNull();
      // Exactly the one previously-failed page recovered, nothing lost.
      expect(retried!.pageCount).toBe(initial!.pageCount + 1);
      expect(retried!.failures).toHaveLength(0);

      // The only new requests since the retry started are for /flaky and
      // its own subresources -- never any page that already succeeded,
      // which is what proves this re-attempted just the failed page
      // rather than re-running the whole capture.
      const newRequests = site.getRequestLog().slice(requestsBeforeRetry);
      expect(newRequests.length).toBeGreaterThan(0);
      for (const already of alreadySucceededUrls) {
        expect(newRequests.some((r) => r.url === already || r.url.startsWith(`${already}?`))).toBe(false);
      }

      const archive = await openSiteArchive(out);
      const paths = archive.manifest.pages.map((p) => new URL(p.finalUrl).pathname);
      archive.close();
      expect(paths).toContain('/flaky');
    });
  });

  test('the retried page keeps the archive open-able and offline-browsable afterward', async () => {
    await withSiteFixture(async (site) => {
      const { hooks, out } = await captureHub(site, outDir, 'RetryOpen.sitearchive');

      await fetch(`${site.url}/flaky-fix`);
      await hooks.retryFailedPages(out);
      const retried = await hooks.awaitCapture();
      expect(retried).not.toBeNull();
      expect(retried!.failures).toHaveLength(0);

      await hooks.openSiteArchivePath(out);
      const tabs = await waitForTabs(handle.app, (t) => t.some((x) => x.isSiteArchive), 15_000);
      expect(tabs.some((t) => t.isSiteArchive)).toBe(true);
    });
  });
});
