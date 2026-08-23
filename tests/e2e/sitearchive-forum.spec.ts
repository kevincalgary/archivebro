import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, siteScope } from './sitearchive-helpers';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';

/**
 * Forum-shaped sites, where the content is two levels down.
 *
 * Reported against rangerovers.net: a whole-site capture saved no threads
 * or posts at all. Its front page enqueues 86 in-scope links -- 37 forum
 * sections, 21 member profiles, 22 utility pages, and only 5 threads --
 * and threads otherwise appear only inside section pages, at depth 2. A
 * strictly breadth-first crawl with a page budget spends the entire budget
 * on depth-1 hub pages and never reaches a thread.
 *
 * The fixture reproduces those proportions locally, so this is testable
 * without crawling somebody else's forum.
 */

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'forum-capture-'));
});

test.afterEach(async () => {
  await handle.close();
  await fs.rm(outDir, { recursive: true, force: true });
});

async function captureForum(baseUrl: string, maxPages: number) {
  const hooks = siteHooks(handle.app);
  const tabs = await hooks.listTabs();
  const outputPath = path.join(outDir, 'forum.sitearchive');

  await hooks.captureSiteToPath(tabs[0]!.id, siteScope({ maxPages, maxDepth: 4 }), outputPath);
  const result = await hooks.awaitCapture();
  expect(result).not.toBeNull();

  const opened = await openSiteArchive(outputPath);
  const paths = opened.manifest.pages.map((p) => new URL(p.finalUrl).pathname);
  const failures = opened.manifest.failures;
  await opened.close?.();

  return {
    paths,
    failures,
    threads: paths.filter((p) => /^\/forum\/thread-/.test(p)),
    sections: paths.filter((p) => /^\/forum\/section-/.test(p)),
    members: paths.filter((p) => /^\/forum\/members\//.test(p)),
  };
}

test.describe('capturing a forum', () => {
  test('a budgeted capture reaches the threads, not just the section indexes', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum`);

      // 12 sections + 8 member profiles + 6 utility pages sit at depth 1;
      // all 72 threads sit at depth 2. Breadth-first, this budget is gone
      // before the first thread.
      const { threads, sections, paths } = await captureForum(site.url, 25);

      expect(paths.length).toBeGreaterThan(1);
      expect(sections.length).toBeGreaterThan(0);
      // The actual content has to be in there.
      expect(threads.length).toBeGreaterThanOrEqual(5);
    });
  });

  test('no single page can monopolise the crawl budget', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum`);

      const { threads, sections } = await captureForum(site.url, 25);

      // The index alone offers 26 links. If it were allowed to run the
      // whole crawl, every captured page would be one of its children and
      // the threads discovered underneath them would never get a turn.
      expect(sections.length).toBeGreaterThan(0);
      expect(threads.length).toBeGreaterThan(0);
      // Neither layer should have swallowed everything.
      expect(sections.length).toBeLessThan(24);
    });
  });

  test('non-content routes are skipped, and visibly so', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum`);

      const { members, paths, failures } = await captureForum(site.url, 25);

      // Login/register/search/member profiles are not archivable content
      // and eat a budget that should be spent on threads.
      expect(members).toHaveLength(0);
      expect(paths.filter((p) => /\/(login|register|search|new-thread)$/.test(p))).toHaveLength(0);

      // Skipped silently is how this went unnoticed; it must be recorded.
      const skipped = failures.filter((f) => f.kind === 'skipped-non-content');
      expect(skipped.length).toBeGreaterThan(0);
      expect(skipped.some((f) => f.url.includes('/login'))).toBe(true);
    });
  });

  test('a nav link on every page is recorded as one skip, not one per page', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum`);

      const { failures, paths } = await captureForum(site.url, 25);

      // The fixture's global nav carries /forum/login and /forum/search on
      // every page, as any real site does. Skips are decided before the
      // enqueue dedupe, so without their own guard each one is recorded
      // once per page crawled -- burying the genuine failures.
      expect(paths.length).toBeGreaterThan(5);
      const loginSkips = failures.filter((f) => f.kind === 'skipped-non-content' && f.url.includes('/forum/login'));
      expect(loginSkips).toHaveLength(1);

      // No skipped URL should appear twice, whatever the kind.
      const skipUrls = failures.filter((f) => f.kind.startsWith('skipped-')).map((f) => f.url);
      expect(new Set(skipUrls).size).toBe(skipUrls.length);
    });
  });

  test('stopping at the page limit is recorded in the archive', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/forum`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/forum`);

      const { failures } = await captureForum(site.url, 10);

      // A truncated capture that looks complete is a silent data problem:
      // the archive should say it stopped early and how much it left.
      const limit = failures.find((f) => f.kind === 'stopped-at-limit');
      expect(limit).toBeTruthy();
      expect(limit!.message).toMatch(/page limit/i);
      expect(limit!.message).toMatch(/still queued|never captured/i);
    });
  });
});
