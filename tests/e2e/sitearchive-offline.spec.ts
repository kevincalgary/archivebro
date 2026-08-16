import { test, expect } from '@playwright/test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { launchApp, navigateViaAddressBar, waitForTabs, type AppHandle } from './helpers';
import { withSiteFixture, siteHooks, currentPageScope, siteScope, dismissCaptureDialog } from './sitearchive-helpers';
import { openSiteArchive } from '../../src/main/sitearchive/archiveReader';

let handle: AppHandle;
let outDir: string;

test.beforeEach(async () => {
  handle = await launchApp();
  outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sitearchive-offline-'));
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

/** Capture the fixture site, then close the server so nothing is reachable. */
async function captureThenGoOffline(
  scopeOverrides: Parameters<typeof siteScope>[0] = {},
  startPath = '/',
): Promise<{ archivePath: string; baseUrl: string }> {
  let archivePath = '';
  let baseUrl = '';
  await withSiteFixture(async (site) => {
    baseUrl = site.url;
    await navigateViaAddressBar(handle, `${site.url}${startPath}`);
    await waitForTabs(handle.app, (t) => !!t[0]?.url.includes(startPath === '/' ? site.url : startPath));

    archivePath = path.join(outDir, 'Offline.sitearchive');
    const hooks = siteHooks(handle.app);
    await hooks.captureSiteToPath(await activeTabId(), siteScope({ maxDepth: 2, maxPages: 15, ...scopeOverrides }), archivePath);
    const result = await hooks.awaitCapture();
    expect(result).toBeTruthy();
  });
  // Close the completion dialog so its overlay doesn't block later clicks.
  await dismissCaptureDialog(handle);
  // The fixture server is now closed: anything that still works below is
  // genuinely being served from the archive, not the network.
  return { archivePath, baseUrl };
}

/** Wait until the site-archive tab exists AND has finished loading a page. */
async function waitForLoadedArchiveTab(timeout = 15_000) {
  return waitForTabs(
    handle.app,
    (t) => t.some((x) => x.isSiteArchive && x.url.startsWith('archive-site://') && !x.isLoading),
    timeout,
  );
}

test.describe('offline .sitearchive viewing', () => {
  test('opens an archive in a tab flagged as an offline site archive', async () => {
    const { archivePath } = await captureThenGoOffline();

    const hooks = siteHooks(handle.app);
    const tabId = await hooks.openSiteArchivePath(archivePath);
    expect(tabId).toBeTruthy();

    const tabs = await waitForLoadedArchiveTab();
    const archiveTab = tabs.find((t) => t.isSiteArchive)!;
    expect(archiveTab.url.startsWith('archive-site://')).toBe(true);
    expect(archiveTab.isOffline).toBe(true);
    expect(archiveTab.siteArchivePath).toBe(archivePath);
  });

  test('renders archived page content with the server gone', async () => {
    const { archivePath } = await captureThenGoOffline();
    const hooks = siteHooks(handle.app);
    await hooks.openSiteArchivePath(archivePath);

    const tabs = await waitForTabs(
      handle.app,
      (t) => t.some((x) => x.isSiteArchive && x.title.includes('Fixture Site Home')),
      15_000,
    );
    const archiveTab = tabs.find((t) => t.isSiteArchive)!;
    // The title comes from the archived page's own <title>, which means
    // the HTML rendered from the container with no network available.
    expect(archiveTab.title).toContain('Fixture Site Home');
  });

  test('the route map resolves in-archive links to archived pages', async () => {
    const { archivePath, baseUrl } = await captureThenGoOffline();

    const archive = await openSiteArchive(archivePath);
    try {
      // A relative link ("about") and an absolute one ("/products/widget")
      // both normalize to routes that point at real archived pages.
      const aboutRoute = archive.lookupRoute(`${baseUrl}/about`);
      expect(aboutRoute?.target.type).toBe('page');

      const widgetRoute = archive.lookupRoute(`${baseUrl}/products/widget`);
      expect(widgetRoute?.target.type).toBe('page');

      // Every page route must point at a page that actually exists.
      for (const route of archive.manifest.routes) {
        if (route.target.type === 'page') {
          expect(archive.getPage(route.target.pageId)).toBeTruthy();
        } else if (route.target.type === 'asset') {
          expect(archive.getAsset(route.target.sha256)).toBeTruthy();
        }
      }
    } finally {
      archive.close();
    }
  });

  test('a link to a page that was never captured has no route (offline page is shown instead)', async () => {
    const { archivePath, baseUrl } = await captureThenGoOffline({ maxDepth: 0, maxPages: 1 });
    const archive = await openSiteArchive(archivePath);
    try {
      // With depth 0 only the start page exists, so /about was never captured.
      expect(archive.lookupRoute(`${baseUrl}/about`)).toBeNull();
    } finally {
      archive.close();
    }
  });

  test('archived assets are served from the container and match their checksums', async () => {
    const { archivePath } = await captureThenGoOffline({ maxDepth: 0, maxPages: 1 });
    const archive = await openSiteArchive(archivePath);
    try {
      expect(archive.manifest.assets.length).toBeGreaterThan(0);
      // readEntry verifies SHA-256 against the manifest; if any asset were
      // corrupt or tampered with this would throw.
      for (const asset of archive.manifest.assets) {
        const buf = await archive.readEntry(asset.path, asset.sha256);
        expect(buf.length).toBe(asset.byteSize);
      }
    } finally {
      archive.close();
    }
  });

  test('back and forward navigation works inside an archive', async () => {
    const { archivePath } = await captureThenGoOffline();
    const hooks = siteHooks(handle.app);
    const tabId = await hooks.openSiteArchivePath(archivePath);

    await waitForLoadedArchiveTab();

    const archive = await openSiteArchive(archivePath);
    let secondPageId = '';
    try {
      const other = archive.manifest.pages.find((p) => p.pageId !== archive.entryPageId);
      secondPageId = other!.pageId;
    } finally {
      archive.close();
    }

    // Navigate to a second archived page, then walk history back/forward.
    await hooks.evalInActiveTab(
      `window.location.href = ${JSON.stringify(`archive-site://`)} + location.host + '/page/${secondPageId}'`,
    );
    await waitForTabs(handle.app, (t) => {
      const at = t.find((x) => x.id === tabId);
      return !!at && at.url.includes(secondPageId) && !at.isLoading;
    }, 15_000);

    let tabs = await waitForTabs(handle.app, (t) => !!t.find((x) => x.id === tabId)?.canGoBack, 10_000);
    expect(tabs.find((t) => t.id === tabId)?.canGoBack).toBe(true);

    await handle.window.getByRole('button', { name: 'Back' }).click();
    tabs = await waitForTabs(handle.app, (t) => {
      const at = t.find((x) => x.id === tabId);
      return !!at && !at.url.includes(secondPageId);
    }, 10_000);

    await handle.window.getByRole('button', { name: 'Forward' }).click();
    tabs = await waitForTabs(handle.app, (t) => {
      const at = t.find((x) => x.id === tabId);
      return !!at && at.url.includes(secondPageId);
    }, 10_000);
    expect(tabs.find((t) => t.id === tabId)?.url).toContain(secondPageId);
  });

  test('opening a corrupt archive fails cleanly without opening a tab', async () => {
    const bogus = path.join(outDir, 'corrupt.sitearchive');
    await fs.writeFile(bogus, 'not a zip at all');

    const hooks = siteHooks(handle.app);
    const before = (await hooks.listTabs()).length;
    await expect(hooks.openSiteArchivePath(bogus)).rejects.toThrow();
    const after = (await hooks.listTabs()).length;
    expect(after).toBe(before);
  });

  test('opening an archive whose manifest points outside the container is refused', async () => {
    const { ZipArchive } = await import('archiver');
    const evil = path.join(outDir, 'evil.sitearchive');
    const manifest = {
      formatVersion: 1,
      archiveId: 'evil',
      startUrl: 'https://e.com/',
      startFinalUrl: 'https://e.com/',
      siteTitle: 'evil',
      capturedAt: new Date().toISOString(),
      scope: currentPageScope(),
      pages: [
        {
          pageId: 'p1',
          originalUrl: 'https://e.com/',
          finalUrl: 'https://e.com/',
          normalizedUrl: 'https://e.com/',
          title: 'x',
          depth: 0,
          capturedAt: new Date().toISOString(),
          htmlPath: '../../../../../../etc/passwd',
          htmlSha256: 'x',
          screenshotPath: null,
          screenshotSha256: null,
          textPath: null,
          textSha256: null,
          redirectedFrom: [],
          contentType: 'text/html',
          byteSize: 1,
        },
      ],
      assets: [],
      responses: [],
      routes: [],
      failures: [],
      appVersion: '0.1.0',
      totalUncompressedBytes: 0,
      indexPath: null,
      indexSha256: null,
    };
    await new Promise<void>((resolve, reject) => {
      const ws = require('node:fs').createWriteStream(evil);
      const zip = new ZipArchive({ zlib: { level: 1 } });
      ws.on('close', () => resolve());
      zip.on('error', reject);
      zip.pipe(ws);
      zip.append(JSON.stringify(manifest), { name: 'manifest.json' });
      void zip.finalize();
    });

    const hooks = siteHooks(handle.app);
    await expect(hooks.openSiteArchivePath(evil)).rejects.toThrow();
  });
});
