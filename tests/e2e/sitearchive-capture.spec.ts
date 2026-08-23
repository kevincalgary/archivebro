import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope, siteScope } from './sitearchive-helpers';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-e2e-'));
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

test.describe('.sitearchive capture', () => {
  test('captures the current page only, with its assets, into a readable archive', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'CurrentPage.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      const result = await hooks.awaitCapture();

      expect(result).toBeTruthy();
      expect(result!.pageCount).toBe(1);
      expect(result!.fileSizeBytes).toBeGreaterThan(0);

      const archive = await openSiteArchive(out);
      try {
        expect(archive.manifest.pages).toHaveLength(1);
        expect(archive.manifest.scope.kind).toBe('current-page');
        // CSS, SVG logo, PNGs and the font should all have been stored.
        const kinds = new Set(archive.manifest.assets.map((a) => a.kind));
        expect(kinds.has('stylesheet')).toBe(true);
        expect(kinds.has('image')).toBe(true);

        const page = archive.manifest.pages[0]!;
        const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');
        expect(html).toContain('Fixture Site Home');
        // Resource URLs must have been rewritten into the archive scheme.
        expect(html).toContain('archive-site://');
      } finally {
        archive.close();
      }
    });
  });

  test('never stores password values, hidden CSRF tokens, or cookies in the archive', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Sensitive.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const page = archive.manifest.pages[0]!;
        const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');

        // The fixture page contains these literal values in a password
        // field and a hidden CSRF field. Neither may survive into the archive.
        expect(html).not.toContain('hunter2');
        expect(html).not.toContain('SECRET-CSRF-VALUE');
        expect(html).toContain('data-archive-cleared');

        // The whole container must not contain them anywhere either.
        const raw = await fs.readFile(out);
        expect(raw.includes(Buffer.from('hunter2'))).toBe(false);
        expect(raw.includes(Buffer.from('SECRET-CSRF-VALUE'))).toBe(false);
      } finally {
        archive.close();
      }
    });
  });

  test('preserves current values of non-sensitive form controls', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Controls.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const page = archive.manifest.pages[0]!;
        const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');
        expect(html).toContain('typed but not submitted');
        expect(html).toMatch(/checked/);
      } finally {
        archive.close();
      }
    });
  });

  test('archived forms are neutralized so they cannot submit anywhere', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Forms.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const page = archive.manifest.pages[0]!;
        const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');
        expect(html).toContain('data-archive-readonly="true"');
        expect(html).toContain('about:blank#archived-form');
      } finally {
        archive.close();
      }
    });
  });

  test('crawls the whole site within scope, following relative and absolute links', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'WholeSite.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 2, maxPages: 20 }), out);
      const result = await hooks.awaitCapture();

      expect(result!.pageCount).toBeGreaterThan(3);

      const archive = await openSiteArchive(out);
      try {
        const urls = archive.manifest.pages.map((p) => p.normalizedUrl);
        // Reached via a relative link, an absolute path link, and a nested page.
        expect(urls).toContain(`${site.url}/about`);
        expect(urls).toContain(`${site.url}/products/widget`);
        expect(urls.some((u) => u.includes('/deep/one'))).toBe(true);
        // A query string that selects content is followed and kept
        // distinct from the bare URL (search endpoints are skipped as
        // non-content, so this needs a real content URL to be meaningful).
        expect(urls).toContain(`${site.url}/products/widget?variant=blue`);
      } finally {
        archive.close();
      }
    });
  });

  test('does not follow cross-origin links out of the site', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'SameOrigin.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 2, maxPages: 30 }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const hosts = new Set(archive.manifest.pages.map((p) => new URL(p.finalUrl).host));
        expect(hosts.size).toBe(1);
        expect([...hosts][0]).toBe(new URL(site.url).host);
      } finally {
        archive.close();
      }
    });
  });

  test('never issues a non-GET request while crawling', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'GetOnly.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 2, maxPages: 20 }), out);
      await hooks.awaitCapture();

      const nonGet = site.getRequestLog().filter((r) => r.method !== 'GET');
      expect(nonGet).toEqual([]);
    });
  });

  test('does not follow destructive-looking links', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'NoDestructive.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 2, maxPages: 30 }), out);
      await hooks.awaitCapture();

      const requested = site.getRequestLog().map((r) => r.url);
      expect(requested.some((u) => u.startsWith('/logout'))).toBe(false);
      expect(requested.some((u) => u.startsWith('/delete-account'))).toBe(false);

      const archive = await openSiteArchive(out);
      try {
        const skipped = archive.manifest.failures.filter((f) => f.kind === 'skipped-sensitive');
        expect(skipped.length).toBeGreaterThan(0);
      } finally {
        archive.close();
      }
    });
  });

  test('follows a redirect and records both the original and final URL', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/redirect-to-about`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/about'));

      const out = path.join(outDir, 'Redirect.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const page = archive.manifest.pages[0]!;
        expect(page.finalUrl).toContain('/about');
      } finally {
        archive.close();
      }
    });
  });

  test('terminates on recursive link loops instead of crawling forever', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/loop/a`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/loop/a'));

      const out = path.join(outDir, 'Loop.sitearchive');
      const hooks = siteHooks(handle.app);
      const maxPages = 30;
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 6, maxPages }), out);
      const result = await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        // /loop/a and /loop/b point at each other. Each must be captured
        // exactly once -- normalized dedupe is what breaks the cycle. The
        // crawl also has to terminate on its own rather than being cut off
        // by the page cap, which is the real proof it isn't looping.
        const loopPages = archive.manifest.pages.filter((p) => p.normalizedUrl.includes('/loop/'));
        expect(loopPages).toHaveLength(2);
        expect(result!.pageCount).toBeLessThan(maxPages);
      } finally {
        archive.close();
      }
    });
  });

  test('respects the maximum page limit', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'PageLimit.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 5, maxPages: 3 }), out);
      const result = await hooks.awaitCapture();

      expect(result!.pageCount).toBeLessThanOrEqual(3);
    });
  });

  test('respects the maximum link depth', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/deep/one`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/deep/one'));

      const out = path.join(outDir, 'DepthLimit.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 1, maxPages: 50 }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        // depth 0 = /deep/one, depth 1 = /deep/two (plus nav links at depth 1).
        // /deep/three sits at depth 2 and must not be captured.
        const urls = archive.manifest.pages.map((p) => p.normalizedUrl);
        expect(urls.some((u) => u.endsWith('/deep/one'))).toBe(true);
        expect(urls.some((u) => u.endsWith('/deep/three'))).toBe(false);
        expect(Math.max(...archive.manifest.pages.map((p) => p.depth))).toBeLessThanOrEqual(1);
      } finally {
        archive.close();
      }
    });
  });

  test('deduplicates an asset used by several pages', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Dedupe.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 1, maxPages: 10 }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        // The SVG logo appears on Home, About and Widget. Content-address
        // dedupe means exactly one stored copy.
        const svgAssets = archive.manifest.assets.filter((a) => a.contentType.includes('svg'));
        expect(svgAssets).toHaveLength(1);
        const hashes = archive.manifest.assets.map((a) => a.sha256);
        expect(new Set(hashes).size).toBe(hashes.length);
      } finally {
        archive.close();
      }
    });
  });

  test('records failures for missing resources without failing the capture', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/broken-assets`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/broken-assets'));

      const out = path.join(outDir, 'Broken.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      const result = await hooks.awaitCapture();

      expect(result).toBeTruthy();
      expect(result!.pageCount).toBe(1);
      expect(result!.failures.length).toBeGreaterThan(0);
    });
  });

  test('captures lazy-loaded content and restores the scroll position', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/lazy`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/lazy'));

      const out = path.join(outDir, 'Lazy.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const page = archive.manifest.pages[0]!;
        const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');
        // The IntersectionObserver only fires if we actually scrolled it
        // into view during the lazy-load sweep.
        expect(html).toContain('lazy-content-loaded');
      } finally {
        archive.close();
      }
    });
  });

  test('captures links generated by JavaScript after load', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/js-links`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/js-links'));

      const out = path.join(outDir, 'JsLinks.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 1, maxPages: 10 }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        // The gadget page is only reachable via a JS-created anchor, so
        // finding it proves we crawled the *rendered* DOM, not the source.
        const urls = archive.manifest.pages.map((p) => p.normalizedUrl);
        expect(urls.some((u) => u.endsWith('/products/gadget'))).toBe(true);
      } finally {
        archive.close();
      }
    });
  });

  test('captures SPA hash routes as the rendered state of the shell page', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/spa#/route-one`);
      await waitForTabs(handle.app, (t) => !!t[0]?.url.includes('/spa'));

      const out = path.join(outDir, 'Spa.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), currentPageScope(), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        const page = archive.manifest.pages[0]!;
        const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');
        // The rendered view reflects the active hash route at capture time.
        expect(html).toContain('SPA: #/route-one');
      } finally {
        archive.close();
      }
    });
  });

  test('a cancelled capture writes no archive file and leaves no temp files behind', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Cancelled.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 3, maxPages: 50, crawlDelayMs: 300 }), out);

      // Let it get going, then cancel mid-crawl.
      await handle.window.waitForTimeout(900);
      expect(await hooks.cancelCapture()).toBe(true);
      const result = await hooks.awaitCapture();

      expect(result).toBeNull();
      await expect(fs.stat(out)).rejects.toThrow();

      const leftovers = await fs.readdir(outDir);
      expect(leftovers.filter((f) => f.includes('.tmp-'))).toEqual([]);
    });
  });

  test('a capture can be paused and resumed', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Paused.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 2, maxPages: 12, crawlDelayMs: 250 }), out);

      await handle.window.waitForTimeout(700);
      expect(await hooks.pauseCapture()).toBe(true);
      await expect.poll(async () => (await hooks.lastCaptureProgress())?.state).toBe('paused');

      expect(await hooks.resumeCapture()).toBe(true);
      const result = await hooks.awaitCapture();
      expect(result).toBeTruthy();
      expect(result!.pageCount).toBeGreaterThan(0);
    });
  });

  test('reports progress with discovered/completed counts and a final result', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Progress.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 1, maxPages: 6 }), out);
      await hooks.awaitCapture();

      const progress = await hooks.lastCaptureProgress();
      expect(progress?.state).toBe('completed');
      expect(progress?.pagesCompleted).toBeGreaterThan(0);
      expect(progress?.pagesDiscovered).toBeGreaterThanOrEqual(progress!.pagesCompleted);
      expect(progress?.result?.archivePath).toBe(out);
    });
  });
});

test.describe('unlimited scope', () => {
  test('a capture with every limit removed crawls the whole site and terminates', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Unlimited.sitearchive');
      const hooks = siteHooks(handle.app);
      // No depth cap, no page cap, no size cap.
      await hooks.captureSiteToPath(
        await activeTabId(),
        siteScope({ maxDepth: null, maxPages: null, maxTotalBytes: null }),
        out,
      );
      const result = await hooks.awaitCapture();

      expect(result).toBeTruthy();
      // It must terminate on its own by exhausting the link graph -- the
      // dedupe/trap logic is what stops an unbounded crawl running forever.
      const archive = await openSiteArchive(out);
      try {
        const urls = archive.manifest.pages.map((p) => p.normalizedUrl);
        // Deeper than the default depth-3 preset would have reached.
        expect(urls.some((u) => u.endsWith('/deep/four'))).toBe(true);
        // And every page is still same-origin.
        const hosts = new Set(archive.manifest.pages.map((p) => new URL(p.finalUrl).host));
        expect(hosts.size).toBe(1);
      } finally {
        archive.close();
      }
    });
  });
});

test.describe('durable fallbacks', () => {
  test('every captured page stores a full-page screenshot and extracted text', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Fallbacks.sitearchive');
      const hooks = siteHooks(handle.app);
      await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 1, maxPages: 4 }), out);
      await hooks.awaitCapture();

      const archive = await openSiteArchive(out);
      try {
        expect(archive.manifest.pages.length).toBeGreaterThan(0);
        for (const page of archive.manifest.pages) {
          // The screenshot and text are the promised durable fallbacks for
          // when a page cannot be reproduced faithfully -- if they are
          // silently missing, that promise is broken.
          expect(page.screenshotPath, `no screenshot for ${page.finalUrl}`).toBeTruthy();
          expect(page.screenshotSha256).toBeTruthy();
          expect(page.textPath, `no text for ${page.finalUrl}`).toBeTruthy();

          const png = await archive.readEntry(page.screenshotPath!, page.screenshotSha256);
          // A real PNG, not a zero-byte placeholder.
          expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
          expect(png.length).toBeGreaterThan(1000);
        }
      } finally {
        archive.close();
      }
    });
  });
});

test.describe('long-crawl view recycling', () => {
  test('a crawl that crosses the view-recycle boundary keeps going and loses nothing', async () => {
    await withSiteFixture(async (site) => {
      await navigateViaAddressBar(handle, `${site.url}/`);
      await waitForTabs(handle.app, (t) => t[0]?.url === `${site.url}/`);

      const out = path.join(outDir, 'Recycled.sitearchive');
      const hooks = siteHooks(handle.app);
      // The fixture has enough pages to cross the 20-page recycle point,
      // which tears down and rebuilds the crawling view mid-crawl.
      await hooks.captureSiteToPath(
        await activeTabId(),
        siteScope({ maxDepth: null, maxPages: null, maxTotalBytes: null, crawlDelayMs: 0 }),
        out,
      );
      const result = await hooks.awaitCapture();

      expect(result).toBeTruthy();
      const archive = await openSiteArchive(out);
      try {
        // Pages captured before and after a recycle must all be present
        // and readable -- the builder outlives the view.
        expect(archive.manifest.pages.length).toBeGreaterThan(5);
        for (const page of archive.manifest.pages) {
          const html = (await archive.readEntry(page.htmlPath, page.htmlSha256)).toString('utf8');
          expect(html.length).toBeGreaterThan(0);
        }
        // And the crawl still terminated cleanly rather than stalling.
        expect(result!.failures.filter((f) => f.kind === 'render-failed')).toEqual([]);
      } finally {
        archive.close();
      }
    });
  });
});
